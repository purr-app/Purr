//! Password-protected, bounded transfer container. Never writes plaintext staging files.
use aead_stream::{DecryptorBE32, EncryptorBE32};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Block, Params, Version};
use std::io::{Read, Write};
use zeroize::Zeroizing;

pub const MAX_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 10_000;
pub const MAX_VALUE_BYTES: usize = 1024 * 1024;
const CHUNK: usize = 64 * 1024;
const HEADER: usize = 69;
const WRAPPED_KEY: usize = 48;
const MAGIC: &[u8; 8] = b"PURRSEC\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ContainerKind {
    SelectedSecrets = 1,
    RecoveryKeys = 2,
    CredentialBackup = 3,
}

/// Unauthenticated routing hint only. `decode` must still authenticate the full container.
pub fn kind_hint(bytes: &[u8]) -> Result<ContainerKind, String> {
    if bytes.len() < HEADER + WRAPPED_KEY + 16
        || bytes.len() > MAX_FILE_BYTES
        || &bytes[..8] != MAGIC
        || bytes[8] != 1
    {
        return Err("transfer-format-invalid".into());
    }
    match bytes[9] {
        1 => Ok(ContainerKind::SelectedSecrets),
        2 => Ok(ContainerKind::RecoveryKeys),
        3 => Ok(ContainerKind::CredentialBackup),
        _ => Err("transfer-format-invalid".into()),
    }
}

fn derive(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    if password.chars().count() < 12 || password.len() > 1024 {
        return Err("transfer-password-invalid".into());
    }
    let params = Params::new(65536, 3, 4, Some(32)).map_err(|_| "transfer-kdf-invalid")?;
    let mut key = Zeroizing::new([0; 32]);
    let mut memory = Zeroizing::new(vec![Block::default(); params.block_count()]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into_with_memory(
            password.as_bytes(),
            salt,
            key.as_mut(),
            memory.as_mut_slice(),
        )
        .map_err(|_| "transfer-kdf-failed")?;
    Ok(key)
}
fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [std::mem::MaybeUninit::uninit(); N];
    getrandom::fill_uninit(&mut bytes)
        .map(|bytes| bytes.try_into().expect("random buffer length is fixed"))
        .map_err(|_| "transfer-random-unavailable".into())
}
fn write(writer: &mut impl Write, bytes: &[u8]) -> Result<(), String> {
    writer
        .write_all(bytes)
        .map_err(|_| "transfer-write-failed".into())
}
fn read(reader: &mut impl Read, bytes: &mut [u8]) -> Result<(), String> {
    reader
        .read_exact(bytes)
        .map_err(|_| "transfer-file-incomplete".into())
}

/// The caller writes into an atomic ciphertext-only destination and publishes on success.
pub fn encode<W: Write>(
    mut writer: W,
    kind: ContainerKind,
    password: &str,
    payload: &[u8],
) -> Result<(), String> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err("transfer-payload-too-large".into());
    }
    let mut header = Vec::with_capacity(HEADER);
    header.extend_from_slice(MAGIC);
    header.extend([1, kind as u8]);
    for n in [19u32, 65536, 3, 4] {
        header.extend(n.to_be_bytes());
    }
    let salt = random::<16>()?;
    let wrap_nonce = random::<12>()?;
    let stream_nonce = random::<7>()?;
    header.extend(salt);
    header.extend(wrap_nonce);
    header.extend(stream_nonce);
    header.extend((payload.len() as u64).to_be_bytes());
    let wrapping = derive(password, &salt)?;
    let archive_key = Zeroizing::new(random::<32>()?);
    let cipher =
        Aes256Gcm::new_from_slice(wrapping.as_ref()).map_err(|_| "transfer-key-invalid")?;
    let wrapped = cipher
        .encrypt(
            &Nonce::from(wrap_nonce),
            Payload {
                msg: archive_key.as_ref(),
                aad: &header,
            },
        )
        .map_err(|_| "transfer-encryption-failed")?;
    header.extend(wrapped);
    write(&mut writer, &header)?;
    let mut stream = EncryptorBE32::<Aes256Gcm>::from_aead(
        Aes256Gcm::new_from_slice(archive_key.as_ref()).map_err(|_| "transfer-key-invalid")?,
        &stream_nonce.into(),
    );
    let mut remaining = payload;
    while remaining.len() > CHUNK {
        let block = stream
            .encrypt_next(Payload {
                msg: &remaining[..CHUNK],
                aad: &header,
            })
            .map_err(|_| "transfer-encryption-failed")?;
        write(&mut writer, &block)?;
        remaining = &remaining[CHUNK..];
    }
    let last = stream
        .encrypt_last(Payload {
            msg: remaining,
            aad: &header,
        })
        .map_err(|_| "transfer-encryption-failed")?;
    write(&mut writer, &last)
}

/// No plaintext is returned until every chunk, the final marker and EOF authenticate.
pub fn decode<R: Read>(
    mut reader: R,
    expected_kind: ContainerKind,
    password: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut header = Vec::with_capacity(HEADER);
    reader
        .by_ref()
        .take(HEADER as u64)
        .read_to_end(&mut header)
        .map_err(|_| "transfer-file-incomplete")?;
    if header.len() != HEADER {
        return Err("transfer-file-incomplete".into());
    }
    if &header[..8] != MAGIC || header[8] != 1 || header[9] != expected_kind as u8 {
        return Err("transfer-format-invalid".into());
    }
    for (index, n) in [19u32, 65536, 3, 4].iter().enumerate() {
        if header[10 + index * 4..14 + index * 4] != n.to_be_bytes() {
            return Err("transfer-kdf-profile-unsupported".into());
        }
    }
    let length = u64::from_be_bytes(
        header[61..69]
            .try_into()
            .map_err(|_| "transfer-format-invalid")?,
    );
    if length > MAX_PAYLOAD_BYTES as u64 {
        return Err("transfer-payload-too-large".into());
    }
    let length = length as usize;
    let chunks = length.max(1).div_ceil(CHUNK);
    if HEADER + WRAPPED_KEY + length + chunks * 16 > MAX_FILE_BYTES {
        return Err("transfer-file-too-large".into());
    }
    let wrapping = derive(password, &header[26..42])?;
    let mut wrapped = [0; WRAPPED_KEY];
    read(&mut reader, &mut wrapped)?;
    let cipher =
        Aes256Gcm::new_from_slice(wrapping.as_ref()).map_err(|_| "transfer-key-invalid")?;
    let archive_key = Zeroizing::new(
        cipher
            .decrypt(
                &Nonce::try_from(&header[42..54]).map_err(|_| "transfer-format-invalid")?,
                Payload {
                    msg: &wrapped,
                    aad: &header,
                },
            )
            .map_err(|_| "transfer-authentication-failed")?,
    );
    let nonce: [u8; 7] = header[54..61]
        .try_into()
        .map_err(|_| "transfer-format-invalid")?;
    header.extend(wrapped);
    let mut stream = DecryptorBE32::<Aes256Gcm>::from_aead(
        Aes256Gcm::new_from_slice(&archive_key).map_err(|_| "transfer-key-invalid")?,
        &nonce.into(),
    );
    let mut output = Zeroizing::new(Vec::with_capacity(length));
    let mut remaining = length;
    while remaining > CHUNK {
        let mut block = vec![0; CHUNK + 16];
        read(&mut reader, &mut block)?;
        let plain = Zeroizing::new(
            stream
                .decrypt_next(Payload {
                    msg: &block,
                    aad: &header,
                })
                .map_err(|_| "transfer-authentication-failed")?,
        );
        output.extend_from_slice(&plain);
        remaining -= CHUNK;
    }
    let mut block = vec![0; remaining + 16];
    read(&mut reader, &mut block)?;
    let plain = Zeroizing::new(
        stream
            .decrypt_last(Payload {
                msg: &block,
                aad: &header,
            })
            .map_err(|_| "transfer-authentication-failed")?,
    );
    output.extend_from_slice(&plain);
    let mut trailing = [0];
    if reader
        .read(&mut trailing)
        .map_err(|_| "transfer-read-failed")?
        != 0
    {
        return Err("transfer-trailing-data".into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    static PASSWORD: std::sync::LazyLock<String> =
        std::sync::LazyLock::new(crate::security::test_password);
    fn package(payload: &[u8]) -> Vec<u8> {
        let mut file = Vec::new();
        encode(
            &mut file,
            ContainerKind::SelectedSecrets,
            &PASSWORD,
            payload,
        )
        .unwrap();
        file
    }
    fn unpack(file: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        decode(file, ContainerKind::SelectedSecrets, &PASSWORD)
    }
    #[test]
    fn roundtrip_all_kinds_empty_unicode_and_chunk_boundaries() {
        for (kind, payload) in [
            (ContainerKind::SelectedSecrets, Vec::new()),
            (
                ContainerKind::RecoveryKeys,
                "синтетичний 🔐".as_bytes().to_vec(),
            ),
            (ContainerKind::CredentialBackup, vec![42; CHUNK]),
            (ContainerKind::SelectedSecrets, vec![19; CHUNK * 2 + 1]),
        ] {
            let mut file = Vec::new();
            encode(&mut file, kind, &PASSWORD, &payload).unwrap();
            assert_eq!(*decode(file.as_slice(), kind, &PASSWORD).unwrap(), payload);
        }
    }
    #[test]
    fn wrong_password_corruption_reorder_truncation_and_trailing_fail_closed() {
        let file = package(&vec![42; CHUNK * 2 + 9]);
        assert!(decode(
            file.as_slice(),
            ContainerKind::SelectedSecrets,
            &crate::security::test_password()
        )
        .is_err());
        assert!(decode(file.as_slice(), ContainerKind::RecoveryKeys, &PASSWORD).is_err());
        for offset in [
            0,
            8,
            10,
            26,
            42,
            54,
            61,
            HEADER,
            HEADER + WRAPPED_KEY,
            file.len() - 1,
        ] {
            let mut corrupt = file.clone();
            corrupt[offset] ^= 1;
            assert!(unpack(&corrupt).is_err(), "offset {offset}");
        }
        for len in [0, HEADER - 1, HEADER + WRAPPED_KEY, file.len() - 1] {
            assert!(unpack(&file[..len]).is_err());
        }
        let mut trailing = file.clone();
        trailing.push(0);
        assert!(unpack(&trailing).is_err());
        let start = HEADER + WRAPPED_KEY;
        let mut reordered = file.clone();
        reordered[start..start + CHUNK + 16]
            .copy_from_slice(&file[start + CHUNK + 16..start + 2 * (CHUNK + 16)]);
        assert!(unpack(&reordered).is_err());
    }
    #[test]
    fn invalid_limits_and_kdf_are_rejected_before_allocation() {
        let mut file = package(b"synthetic");
        file[61..69].copy_from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(unpack(&file).unwrap_err(), "transfer-payload-too-large");
        assert!(encode(
            Vec::new(),
            ContainerKind::SelectedSecrets,
            &PASSWORD[..5],
            b""
        )
        .is_err());
        assert!(encode(
            Vec::new(),
            ContainerKind::SelectedSecrets,
            &PASSWORD.repeat(29),
            b""
        )
        .is_err());
    }

    #[test]
    #[ignore = "opt-in synthetic Argon2id timing on the current machine"]
    fn argon2id_profile_timing() {
        for _ in 0..3 {
            let start = std::time::Instant::now();
            let _key = derive(&PASSWORD, &random::<16>().unwrap()).unwrap();
            eprintln!("Argon2id v19 m=65536 t=3 p=4: {:?}", start.elapsed());
        }
    }
}
