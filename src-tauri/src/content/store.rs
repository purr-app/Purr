use super::{
    contracts::{
        ByteRange, ContentInfo, ContentMetadata, ContentOperationResult, ContentWindow,
        FormatRequest, JsonQueryRequest, LinePage, LineSegment, ResponseContentRef, SearchMatch,
        SearchPage, SearchQuery,
    },
    operations::{format_document, query_document, query_large_document},
};
use crate::{
    persistence::local_records::LocalStateStore,
    security::{LocalCipher, RootCiphers, RootKeyStore},
};
use aes_gcm::aead::rand_core::{OsRng, RngCore};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use regex::bytes::RegexBuilder;
use regex_syntax::Parser as RegexParser;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    io::Write,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const LINE_PAGE_BYTES: usize = 192 * 1024;
const LINE_SEGMENT_BYTES: usize = 16 * 1024;
const SEARCH_WINDOW_BYTES: usize = 4 * 1024 * 1024;
const SEARCH_MAX_PATTERN_BYTES: usize = 4 * 1024;
const SEARCH_MAX_MATCH_BYTES: usize = 64 * 1024;
const SEARCH_PAGE_MATCHES: usize = 1_000;
const STRUCTURED_PARSE_BYTES: u64 = 32 * 1024 * 1024;
const INLINE_OPERATION_RESULT_BYTES: usize = 256 * 1024;

const ENCRYPTED_TABLES: [&str; 12] = [
    "workspace_local_state",
    "drafts",
    "document_session_state",
    "request_executions",
    "cookie_jar",
    "schema_cache",
    "recent_items",
    "attachments",
    "pending_commits",
    "response_bodies",
    "secret_values",
    "response_content_chunks",
];

#[derive(Clone, Copy)]
pub struct ResponseLimits {
    pub chunk_bytes: usize,
    pub max_window_bytes: usize,
    pub max_content_bytes: u64,
    pub max_retained_bytes: Option<u64>,
    pub staging_ttl_seconds: i64,
}

impl Default for ResponseLimits {
    fn default() -> Self {
        Self {
            chunk_bytes: 256 * 1024,
            max_window_bytes: 4 * 1024 * 1024,
            max_content_bytes: 128 * 1024 * 1024,
            max_retained_bytes: None,
            staging_ttl_seconds: 60 * 60,
        }
    }
}

pub struct ResponseContentStore {
    db: Connection,
    cipher: LocalCipher,
    limits: ResponseLimits,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ContentWriteTiming {
    pub encryption: Duration,
    pub sqlite: Duration,
}

impl ResponseContentStore {
    pub fn open(path: &Path, root_store: &dyn RootKeyStore) -> Result<Self, String> {
        Self::open_with_limits(path, root_store, ResponseLimits::default())
    }

    fn open_with_limits(
        path: &Path,
        root_store: &dyn RootKeyStore,
        limits: ResponseLimits,
    ) -> Result<Self, String> {
        let mut db = Connection::open(path).map_err(|_| "Cannot open response storage")?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "Cannot configure response storage")?;
        db.execute_batch(
            // Response bodies are reconstructible runtime data. NORMAL keeps WAL
            // transactions atomic while avoiding a disk sync for every streamed
            // append; canonical project data continues to use FULL durability.
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )
        .map_err(|_| "Cannot configure response storage")?;
        LocalStateStore::migrate(&mut db)?;
        let mut has_encrypted_data = false;
        for table in ENCRYPTED_TABLES {
            has_encrypted_data |= db
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {table})"),
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| "Cannot inspect response storage")?;
        }
        let cipher = RootCiphers::open(root_store, has_encrypted_data, false)?.response_content;
        let mut store = Self { db, cipher, limits };
        store.cleanup_expired(now_seconds())?;
        Ok(store)
    }

    #[allow(dead_code)] // Native HTTP starts using the writer API in Phase 6.
    pub fn create_staging(
        &mut self,
        metadata: ContentMetadata,
    ) -> Result<ResponseContentRef, String> {
        self.cleanup_expired(now_seconds())?;
        let mut random = [0_u8; 16];
        OsRng.fill_bytes(&mut random);
        let id = format!(
            "content-{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let created_at = now_seconds();
        self.db.execute(
            "INSERT INTO response_contents(id,state,byte_length,media_type,charset,created_at,expires_at) VALUES(?1,'staging',0,?2,?3,?4,?5)",
            params![id, metadata.media_type, metadata.charset, created_at, created_at + self.limits.staging_ttl_seconds],
        ).map_err(|_| "Cannot create response content")?;
        self.reference(&id)
    }

    #[allow(dead_code)]
    pub fn append(&mut self, id: &str, bytes: &[u8]) -> Result<ContentWriteTiming, String> {
        validate_id(id)?;
        if bytes.is_empty() {
            return Ok(ContentWriteTiming::default());
        }
        let started = Instant::now();
        let mut encryption = Duration::ZERO;
        let (state, mut offset): (String, u64) = self
            .db
            .query_row(
                "SELECT state,byte_length FROM response_contents WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| "Cannot inspect response content")?
            .ok_or("Response content does not exist")?;
        if state != "staging" {
            return Err("Response content is no longer writable".into());
        }
        let next_length = offset
            .checked_add(bytes.len() as u64)
            .ok_or("Response is too large")?;
        if next_length > self.limits.max_content_bytes {
            return Err("Response exceeds the 128 MiB capture limit.".into());
        }
        if let Some(maximum) = self.limits.max_retained_bytes {
            let retained: u64 = self
                .db
                .query_row(
                    "SELECT COALESCE(SUM(byte_length),0) FROM response_contents",
                    [],
                    |row| row.get(0),
                )
                .map_err(|_| "Cannot inspect response quota")?;
            if retained
                .checked_add(bytes.len() as u64)
                .is_none_or(|total| total > maximum)
            {
                return Err("Response storage quota is exceeded".into());
            }
        }
        let first_index: u64 = self.db.query_row("SELECT COALESCE(MAX(chunk_index)+1,0) FROM response_content_chunks WHERE content_id=?1", [id], |row| row.get(0)).map_err(|_| "Cannot inspect response content")?;
        let transaction = self
            .db
            .transaction()
            .map_err(|_| "Cannot write response content")?;
        for (relative_index, chunk) in bytes.chunks(self.limits.chunk_bytes).enumerate() {
            let index = first_index + relative_index as u64;
            let aad = chunk_aad(id, index, offset, chunk.len() as u64);
            let encryption_started = Instant::now();
            let sealed = self.cipher.seal(chunk, &aad)?;
            encryption += encryption_started.elapsed();
            transaction.execute(
                "INSERT INTO response_content_chunks(content_id,chunk_index,plain_offset,plain_length,crypto_version,nonce,ciphertext) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![id, index, offset, chunk.len() as u64, sealed.version, sealed.nonce.as_slice(), sealed.ciphertext],
            ).map_err(|_| "Cannot write response content")?;
            offset += chunk.len() as u64;
        }
        transaction
            .execute(
                "UPDATE response_contents SET byte_length=?2 WHERE id=?1 AND state='staging'",
                params![id, offset],
            )
            .map_err(|_| "Cannot update response content")?;
        transaction
            .commit()
            .map_err(|_| "Cannot commit response content".to_string())?;
        Ok(ContentWriteTiming {
            encryption,
            sqlite: started.elapsed().saturating_sub(encryption),
        })
    }

    #[allow(dead_code)]
    pub fn finish(&mut self, id: &str) -> Result<ResponseContentRef, String> {
        validate_id(id)?;
        let changed = self
            .db
            .execute(
                "UPDATE response_contents SET state='ready' WHERE id=?1 AND state='staging'",
                [id],
            )
            .map_err(|_| "Cannot complete response content")?;
        if changed != 1 {
            return Err("Response content is not staging".into());
        }
        self.reference(id)
    }

    pub fn inspect(&self, id: &str) -> Result<ContentInfo, String> {
        let reference = self.reference(id)?;
        if !reference.complete {
            return Err("Response content is incomplete".into());
        }
        let (line_count, max_line_bytes) = self.line_statistics(id, reference.byte_length)?;
        Ok(ContentInfo {
            size: reference.byte_length,
            media_type: reference.media_type,
            text_encoding: reference.charset,
            line_count: Some(line_count),
            max_line_bytes: Some(max_line_bytes),
        })
    }

    fn line_statistics(&self, id: &str, size: u64) -> Result<(u64, u64), String> {
        if size == 0 {
            return Ok((0, 0));
        }
        let mut offset = 0_u64;
        let mut line_count = 1_u64;
        let mut current_line = 0_u64;
        let mut maximum_line = 0_u64;
        while offset < size {
            let bytes = self.read_plain_range(
                id,
                offset,
                (size - offset).min(self.limits.max_window_bytes as u64),
            )?;
            if bytes.is_empty() {
                break;
            }
            for byte in &bytes {
                if *byte == b'\n' {
                    maximum_line = maximum_line.max(current_line);
                    current_line = 0;
                    line_count += 1;
                } else {
                    current_line += 1;
                }
            }
            offset += bytes.len() as u64;
        }
        Ok((line_count, maximum_line.max(current_line)))
    }

    pub fn read_range(
        &self,
        id: &str,
        range: ByteRange,
        mode: &str,
    ) -> Result<ContentWindow, String> {
        validate_id(id)?;
        let reference = self.reference(id)?;
        if !reference.complete {
            return Err("Response content is incomplete".into());
        }
        let requested =
            usize::try_from(range.length).map_err(|_| "Response window is too large")?;
        if requested > self.limits.max_window_bytes {
            return Err("Response window exceeds the configured limit".into());
        }
        let bytes = self.read_plain_range(id, range.offset, range.length)?;
        let end = range.offset.saturating_add(bytes.len() as u64);
        let content = match mode {
            "text" => String::from_utf8_lossy(&bytes).into_owned(),
            "hex" => bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
            "bytes" | "base64" => STANDARD.encode(&bytes),
            _ => return Err("Unsupported response window mode".into()),
        };
        Ok(ContentWindow {
            offset: range.offset,
            bytes_read: bytes.len() as u64,
            content,
            complete: end >= reference.byte_length,
        })
    }

    pub fn read_bytes_range(&self, id: &str, range: ByteRange) -> Result<Vec<u8>, String> {
        self.read_plain_range(id, range.offset, range.length)
    }

    pub fn save_to_path(&self, id: &str, path: &Path) -> Result<u64, String> {
        validate_id(id)?;
        let reference = self.reference(id)?;
        if !reference.complete {
            return Err("Response content is incomplete".into());
        }
        let parent = path.parent().ok_or("Invalid response destination")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Cannot create the response destination")?;
        let mut offset = 0_u64;
        while offset < reference.byte_length {
            let bytes = self.read_plain_range(
                id,
                offset,
                (reference.byte_length - offset).min(self.limits.max_window_bytes as u64),
            )?;
            if bytes.is_empty() {
                return Err("Response content ended unexpectedly".into());
            }
            temporary
                .write_all(&bytes)
                .map_err(|_| "Cannot write the response destination")?;
            offset += bytes.len() as u64;
        }
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| "Cannot finish the response destination")?;
        temporary
            .persist(path)
            .map_err(|_| "Cannot replace the response destination")?;
        Ok(offset)
    }

    fn read_plain_range(&self, id: &str, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        validate_id(id)?;
        let reference = self.reference(id)?;
        if !reference.complete {
            return Err("Response content is incomplete".into());
        }
        let requested = usize::try_from(length).map_err(|_| "Response window is too large")?;
        if requested > self.limits.max_window_bytes {
            return Err("Response window exceeds the configured limit".into());
        }
        if offset > reference.byte_length {
            return Err("Response window starts beyond the content".into());
        }
        let end = offset.saturating_add(length).min(reference.byte_length);
        let mut bytes = Vec::with_capacity((end.saturating_sub(offset)) as usize);
        let mut expected_offset = offset;
        let mut statement = self.db.prepare(
            "SELECT chunk_index,plain_offset,plain_length,crypto_version,nonce,ciphertext FROM response_content_chunks WHERE content_id=?1 AND plain_offset < ?3 AND plain_offset + plain_length > ?2 ORDER BY chunk_index",
        ).map_err(|_| "Cannot read response content")?;
        let chunks = statement
            .query_map(params![id, offset, end], |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                ))
            })
            .map_err(|_| "Cannot read response content")?;
        for row in chunks {
            let (index, offset, length, version, nonce, ciphertext) =
                row.map_err(|_| "Cannot read response content")?;
            let plain = self.cipher.open_sealed(
                version,
                &nonce,
                &ciphertext,
                &chunk_aad(id, index, offset, length),
            )?;
            if plain.len() as u64 != length {
                return Err("Response content chunk is damaged".into());
            }
            let from = expected_offset.saturating_sub(offset) as usize;
            let to = (end - offset).min(length) as usize;
            if offset + from as u64 != expected_offset {
                return Err("Response content has a missing or reordered chunk".into());
            }
            bytes.extend_from_slice(&plain[from..to]);
            expected_offset += (to - from) as u64;
        }
        if expected_offset != end {
            return Err("Response content has a missing or reordered chunk".into());
        }
        Ok(bytes)
    }

    pub fn read_lines(
        &self,
        id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<LinePage, String> {
        if let Some(offset) = cursor.and_then(|cursor| cursor.strip_prefix("preview:")) {
            return self.read_preview_lines(id, offset, limit);
        }
        let offset = cursor
            .unwrap_or("0")
            .parse::<u64>()
            .map_err(|_| "Invalid line cursor")?;
        let reference = self.reference(id)?;
        if !reference.complete {
            return Err("Response content is incomplete".into());
        }
        if offset > reference.byte_length {
            return Err("Invalid line cursor".into());
        }
        if offset == reference.byte_length {
            return Ok(LinePage {
                offset,
                bytes_read: 0,
                segments: Vec::new(),
                previous_cursor: (offset > 0)
                    .then(|| offset.saturating_sub(LINE_PAGE_BYTES as u64).to_string()),
                next_cursor: None,
                complete: true,
            });
        }
        let maximum_segments = limit.clamp(1, 1000);
        let requested = (reference.byte_length - offset)
            .min((LINE_PAGE_BYTES + 4) as u64)
            .min(self.limits.max_window_bytes as u64);
        let bytes = self.read_plain_range(id, offset, requested)?;
        let leading = bytes
            .iter()
            .take(3)
            .take_while(|byte| (**byte & 0b1100_0000) == 0b1000_0000)
            .count();
        let page_offset = offset + leading as u64;
        let bytes = &bytes[leading..];
        let page_budget = bytes.len().min(LINE_PAGE_BYTES);
        let previous_byte = if page_offset > 0 {
            self.read_plain_range(id, page_offset - 1, 1)?
                .first()
                .copied()
        } else {
            None
        };
        let mut continuation = previous_byte.is_some_and(|byte| byte != b'\n');
        let mut line_start_offset = (!continuation).then_some(page_offset);
        let mut segments = Vec::new();
        let mut consumed = 0_usize;
        while consumed < page_budget && segments.len() < maximum_segments {
            let remaining = &bytes[consumed..page_budget];
            let newline = remaining.iter().position(|byte| *byte == b'\n');
            let available = newline
                .map(|position| position.min(LINE_SEGMENT_BYTES))
                .unwrap_or_else(|| remaining.len().min(LINE_SEGMENT_BYTES));
            let mut end = consumed + available;
            while end > consumed && std::str::from_utf8(&bytes[consumed..end]).is_err() {
                end -= 1;
            }
            if end == consumed && available > 0 {
                return Err("Response content is not valid UTF-8".into());
            }
            let reaches_newline = newline.is_some_and(|position| position == end - consumed);
            let text_end = if reaches_newline && end > consumed && bytes[end - 1] == b'\r' {
                end - 1
            } else {
                end
            };
            let text = std::str::from_utf8(&bytes[consumed..text_end])
                .map_err(|_| "Response content is not valid UTF-8")?
                .to_string();
            let continues_to_next =
                !reaches_newline && page_offset + (end as u64) < reference.byte_length;
            segments.push(LineSegment {
                byte_offset: page_offset + consumed as u64,
                byte_length: (end - consumed) as u64,
                line_start_offset,
                hidden_bytes: None,
                suffix: None,
                text,
                continues_from_previous: continuation,
                continues_to_next,
            });
            consumed = end;
            if reaches_newline {
                consumed += 1;
                continuation = false;
                line_start_offset = Some(page_offset + consumed as u64);
            } else {
                continuation = true;
            }
            if available == 0 && reaches_newline {
                // Empty logical line: the newline itself advances the cursor.
                continue;
            }
        }
        let next = page_offset + consumed as u64;
        let complete = next >= reference.byte_length;
        Ok(LinePage {
            offset: page_offset,
            bytes_read: consumed as u64,
            segments,
            previous_cursor: (page_offset > 0).then(|| {
                page_offset
                    .saturating_sub(LINE_PAGE_BYTES as u64)
                    .to_string()
            }),
            next_cursor: (!complete).then(|| next.to_string()),
            complete,
        })
    }

    // Presentation-only rows: retain a small prefix/suffix while scanning past a
    // giant logical line. Original bytes remain available to search/query/export.
    fn read_preview_lines(&self, id: &str, cursor: &str, limit: usize) -> Result<LinePage, String> {
        const PREFIX: usize = 96;
        const SUFFIX: usize = 32;
        let offset = cursor.parse::<u64>().map_err(|_| "Invalid line cursor")?;
        let reference = self.reference(id)?;
        if offset > reference.byte_length || !reference.complete {
            return Err("Invalid or incomplete response content".into());
        }
        let mut position = offset;
        let mut segments = Vec::new();
        let mut prefix = Vec::new();
        let mut tail = Vec::new();
        let mut line_start = offset;
        let mut displayed_bytes = 0;
        let mut continued =
            offset > 0 && self.read_plain_range(id, offset - 1, 1)?.first() != Some(&b'\n');
        while position < reference.byte_length
            && segments.len() < limit.clamp(1, 1000)
            && displayed_bytes < LINE_PAGE_BYTES - PREFIX - SUFFIX
        {
            let bytes = self.read_plain_range(
                id,
                position,
                (reference.byte_length - position).min(LINE_PAGE_BYTES as u64),
            )?;
            let mut consumed = 0;
            while consumed < bytes.len() {
                let remainder = &bytes[consumed..];
                let newline = remainder.iter().position(|byte| *byte == b'\n');
                let length = newline.unwrap_or(remainder.len());
                let part = &remainder[..length];
                let prefix_length = (PREFIX - prefix.len()).min(part.len());
                prefix.extend_from_slice(&part[..prefix_length]);
                tail.extend_from_slice(&part[prefix_length..]);
                if tail.len() > SUFFIX {
                    tail.drain(..tail.len() - SUFFIX);
                }
                consumed += length;
                position += length as u64;
                if newline.is_none() && position < reference.byte_length {
                    break;
                }
                let line_length = position - line_start;
                // Keep UTF-8 characters intact at the two preview cuts.
                let mut prefix_end = prefix.len();
                while prefix_end > 0 && std::str::from_utf8(&prefix[..prefix_end]).is_err() {
                    prefix_end -= 1;
                }
                if prefix_end == 0 && !prefix.is_empty() {
                    return Err("Response content is not valid UTF-8".into());
                }
                let tail_start = tail
                    .iter()
                    .take(3)
                    .take_while(|byte| (**byte & 0xc0) == 0x80)
                    .count();
                let suffix = std::str::from_utf8(&tail[tail_start..])
                    .map_err(|_| "Response content is not valid UTF-8")?
                    .to_string();
                let text = std::str::from_utf8(&prefix[..prefix_end])
                    .map_err(|_| "Response content is not valid UTF-8")?
                    .to_string();
                let hidden = line_length.saturating_sub((text.len() + suffix.len()) as u64);
                displayed_bytes += text.len() + suffix.len();
                segments.push(LineSegment {
                    byte_offset: line_start,
                    byte_length: line_length,
                    line_start_offset: (!continued).then_some(line_start),
                    hidden_bytes: (hidden > 0).then_some(hidden),
                    suffix: (!suffix.is_empty()).then_some(suffix),
                    text,
                    continues_from_previous: continued,
                    continues_to_next: false,
                });
                if newline.is_some() {
                    position += 1;
                    consumed += 1;
                }
                line_start = position;
                continued = false;
                prefix.clear();
                tail.clear();
                if segments.len() >= limit.clamp(1, 1000)
                    || displayed_bytes >= LINE_PAGE_BYTES - PREFIX - SUFFIX
                {
                    break;
                }
            }
        }
        Ok(LinePage {
            offset,
            bytes_read: position - offset,
            segments,
            previous_cursor: None,
            next_cursor: (position < reference.byte_length).then(|| format!("preview:{position}")),
            complete: position >= reference.byte_length,
        })
    }

    pub fn search(
        &self,
        id: &str,
        query: &SearchQuery,
        cursor: Option<&str>,
        cancelled: &AtomicBool,
    ) -> Result<SearchPage, String> {
        if query.text.is_empty() {
            return Ok(SearchPage {
                matches: Vec::new(),
                next_cursor: None,
                total_known: Some(0),
            });
        }
        if query.text.len() > SEARCH_MAX_PATTERN_BYTES {
            return Err("Search expression exceeds the 4 KiB limit".into());
        }
        let start = cursor
            .unwrap_or("0")
            .parse::<u64>()
            .map_err(|_| "Invalid search cursor")?;
        let reference = self.reference(id)?;
        if start > reference.byte_length {
            return Err("Invalid search cursor".into());
        }
        let pattern = if query.regular_expression {
            let hir = RegexParser::new()
                .parse(&query.text)
                .map_err(|error| format!("Invalid regular expression: {error}"))?;
            let maximum = hir
                .properties()
                .maximum_len()
                .ok_or("Unbounded regular expressions are unavailable for large responses")?;
            if maximum > SEARCH_MAX_MATCH_BYTES {
                return Err("Regular expression matches may not exceed 64 KiB".into());
            }
            query.text.clone()
        } else {
            regex::escape(&query.text)
        };
        let maximum_match = if query.regular_expression {
            RegexParser::new()
                .parse(&query.text)
                .ok()
                .and_then(|hir| hir.properties().maximum_len())
                .unwrap_or(query.text.len())
        } else {
            query.text.len()
        }
        .max(1);
        let expression = RegexBuilder::new(&pattern)
            .case_insensitive(!query.case_sensitive)
            .unicode(true)
            .build()
            .map_err(|error| format!("Invalid search expression: {error}"))?;
        let overlap = maximum_match.saturating_sub(1).min(SEARCH_MAX_MATCH_BYTES);
        let mut offset = start;
        let mut carry = Vec::new();
        let mut matches = Vec::new();
        while offset < reference.byte_length {
            if cancelled.load(Ordering::Relaxed) {
                return Err("Response content operation cancelled".into());
            }
            let bytes = self.read_plain_range(
                id,
                offset,
                (reference.byte_length - offset).min(SEARCH_WINDOW_BYTES as u64),
            )?;
            if bytes.is_empty() {
                break;
            }
            let carry_length = carry.len();
            let combined_offset = offset.saturating_sub(carry_length as u64);
            carry.extend_from_slice(&bytes);
            for found in expression.find_iter(&carry) {
                let global_start = combined_offset + found.start() as u64;
                let global_end = combined_offset + found.end() as u64;
                if global_end <= offset || global_start < start {
                    continue;
                }
                let snippet_start = found.start().saturating_sub(48);
                let snippet_end = (found.end() + 96).min(carry.len());
                matches.push(SearchMatch {
                    byte_offset: global_start,
                    byte_length: global_end - global_start,
                    line: None,
                    snippet: String::from_utf8_lossy(&carry[snippet_start..snippet_end])
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" "),
                });
                if matches.len() >= SEARCH_PAGE_MATCHES {
                    return Ok(SearchPage {
                        matches,
                        next_cursor: Some(global_end.max(global_start + 1).to_string()),
                        total_known: None,
                    });
                }
            }
            offset += bytes.len() as u64;
            if overlap == 0 {
                carry.clear();
            } else if carry.len() > overlap {
                carry.drain(..carry.len() - overlap);
            }
        }
        Ok(SearchPage {
            total_known: (start == 0).then_some(matches.len() as u64),
            matches,
            next_cursor: None,
        })
    }

    pub fn format(
        &mut self,
        id: &str,
        request: &FormatRequest,
        cancelled: &AtomicBool,
    ) -> Result<ContentOperationResult, String> {
        let bytes = self.read_operation_content(id)?;
        if cancelled.load(Ordering::Relaxed) {
            return Err("Response content operation cancelled".into());
        }
        let output = format_document(&bytes, &request.syntax, request.indent)?;
        if cancelled.load(Ordering::Relaxed) {
            return Err("Response content operation cancelled".into());
        }
        let media_type = match request.syntax.as_str() {
            "json" => "application/json",
            "ndjson" => "application/x-ndjson",
            "xml" => "application/xml",
            _ => "text/plain",
        };
        self.text_operation_result(output, media_type)
    }

    pub fn query(
        &mut self,
        id: &str,
        request: &JsonQueryRequest,
        cancelled: &AtomicBool,
    ) -> Result<ContentOperationResult, String> {
        let reference = self.reference(id)?;
        let bytes = self.read_operation_content(id)?;
        if cancelled.load(Ordering::Relaxed) {
            return Err("Response content operation cancelled".into());
        }
        let ndjson = reference.media_type.as_deref().is_some_and(|media_type| {
            media_type.contains("ndjson")
                || media_type.contains("jsonl")
                || media_type.contains("json-lines")
        });
        let value = if reference.byte_length > STRUCTURED_PARSE_BYTES || ndjson {
            query_large_document(&bytes, &request.language, &request.expression, ndjson)?
        } else {
            query_document(&bytes, &request.language, &request.expression)?
        };
        let encoded = serde_json::to_vec_pretty(&value)
            .map_err(|error| format!("Cannot encode response query result: {error}"))?;
        if encoded.len() <= INLINE_OPERATION_RESULT_BYTES {
            return Ok(ContentOperationResult::Value { value });
        }
        self.derived_content_result(encoded, "application/json")
    }

    fn read_operation_content(&self, id: &str) -> Result<Vec<u8>, String> {
        let reference = self.reference(id)?;
        let mut output = Vec::with_capacity(reference.byte_length as usize);
        let mut offset = 0_u64;
        while offset < reference.byte_length {
            let bytes = self.read_plain_range(
                id,
                offset,
                (reference.byte_length - offset).min(self.limits.max_window_bytes as u64),
            )?;
            if bytes.is_empty() {
                break;
            }
            offset += bytes.len() as u64;
            output.extend_from_slice(&bytes);
        }
        Ok(output)
    }

    fn text_operation_result(
        &mut self,
        bytes: Vec<u8>,
        media_type: &str,
    ) -> Result<ContentOperationResult, String> {
        if bytes.len() <= INLINE_OPERATION_RESULT_BYTES {
            let content = String::from_utf8(bytes)
                .map_err(|_| "Formatted response is not valid UTF-8".to_string())?;
            return Ok(ContentOperationResult::Window {
                window: ContentWindow {
                    offset: 0,
                    bytes_read: content.len() as u64,
                    content,
                    complete: true,
                },
            });
        }
        self.derived_content_result(bytes, media_type)
    }

    fn derived_content_result(
        &mut self,
        bytes: Vec<u8>,
        media_type: &str,
    ) -> Result<ContentOperationResult, String> {
        let reference = self.create_staging(ContentMetadata {
            media_type: Some(media_type.into()),
            charset: Some("utf-8".into()),
        })?;
        let result = self
            .append(&reference.id, &bytes)
            .and_then(|_| self.finish(&reference.id));
        match result {
            Ok(reference) => Ok(ContentOperationResult::Content { reference }),
            Err(error) => {
                let _ = self.release(&reference.id);
                Err(error)
            }
        }
    }

    pub fn release(&mut self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        self.db
            .execute(
                "DELETE FROM response_contents WHERE id=?1 AND state<>'adopted'",
                [id],
            )
            .map_err(|_| "Cannot release response content")?;
        Ok(())
    }

    pub fn cleanup_expired(&mut self, now: i64) -> Result<usize, String> {
        self.db.execute("DELETE FROM response_contents WHERE state<>'adopted' AND expires_at IS NOT NULL AND expires_at<=?1", [now]).map_err(|_| "Cannot clean response content".to_string())
    }

    fn reference(&self, id: &str) -> Result<ResponseContentRef, String> {
        validate_id(id)?;
        self.db
            .query_row(
                "SELECT byte_length,media_type,charset,state FROM response_contents WHERE id=?1",
                [id],
                |row| {
                    let state: String = row.get(3)?;
                    Ok(ResponseContentRef {
                        id: id.into(),
                        byte_length: row.get(0)?,
                        media_type: row.get(1)?,
                        charset: row.get(2)?,
                        line_count: None,
                        max_line_bytes: None,
                        complete: state != "staging",
                    })
                },
            )
            .optional()
            .map_err(|_| "Cannot inspect response content")?
            .ok_or_else(|| "Response content does not exist".into())
    }
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn chunk_aad(id: &str, index: u64, offset: u64, length: u64) -> String {
    format!("purr:response-content:v1|{id}|{index}|{offset}|{length}")
}
fn validate_id(id: &str) -> Result<(), String> {
    if id.starts_with("content-")
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(())
    } else {
        Err("Invalid response content identifier".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        persistence::local_records::{LocalRecord, LocalStateStore},
        security::tests::MemoryRootKeyStore,
    };

    fn store(
        limits: ResponseLimits,
    ) -> (tempfile::TempDir, MemoryRootKeyStore, ResponseContentStore) {
        let directory = tempfile::tempdir().unwrap();
        let root = MemoryRootKeyStore::default();
        let store = ResponseContentStore::open_with_limits(
            &directory.path().join("state.db"),
            &root,
            limits,
        )
        .unwrap();
        (directory, root, store)
    }

    #[test]
    fn staging_chunks_finish_adopt_and_read_across_boundaries() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 60,
        };
        let (_directory, _root, mut store) = store(limits);
        let reference = store
            .create_staging(ContentMetadata {
                media_type: Some("text/plain".into()),
                charset: Some("utf-8".into()),
            })
            .unwrap();
        store.append(&reference.id, b"0123456789\nnext").unwrap();
        assert!(store.inspect(&reference.id).is_err());
        let ready = store.finish(&reference.id).unwrap();
        assert_eq!(ready.byte_length, 15);
        let window = store
            .read_range(
                &reference.id,
                ByteRange {
                    offset: 3,
                    length: 8,
                },
                "text",
            )
            .unwrap();
        assert_eq!(window.content, "3456789\n");
        let lines = store.read_lines(&reference.id, None, 1).unwrap();
        assert_eq!(lines.segments.len(), 1);
        assert_eq!(lines.segments[0].text, "0123456789");
        assert!(!lines.segments[0].continues_to_next);
        store.release(&reference.id).unwrap();
        assert!(store.inspect(&reference.id).is_err());
    }

    #[test]
    fn completed_content_saves_byte_for_byte_without_base64() {
        let limits = ResponseLimits {
            chunk_bytes: 3,
            max_window_bytes: 5,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 60,
        };
        let (directory, _root, mut store) = store(limits);
        let reference = store
            .create_staging(ContentMetadata {
                media_type: Some("application/octet-stream".into()),
                charset: None,
            })
            .unwrap();
        let expected = [0, 1, 2, 3, 127, 128, 254, 255, 42, 10, 11];
        store.append(&reference.id, &expected).unwrap();
        store.finish(&reference.id).unwrap();
        let destination = directory.path().join("download.bin");
        assert_eq!(
            store.save_to_path(&reference.id, &destination).unwrap(),
            expected.len() as u64
        );
        assert_eq!(std::fs::read(destination).unwrap(), expected);
    }

    #[test]
    fn giant_lines_and_millions_of_short_lines_remain_bounded() {
        let limits = ResponseLimits {
            max_content_bytes: 16 * 1024 * 1024,
            ..ResponseLimits::default()
        };
        let (_directory, _root, mut store) = store(limits);
        let giant = store
            .create_staging(ContentMetadata {
                media_type: Some("text/plain".into()),
                charset: Some("utf-8".into()),
            })
            .unwrap();
        store.append(&giant.id, &vec![b'x'; 999 * 1024]).unwrap();
        store.finish(&giant.id).unwrap();
        let info = store.inspect(&giant.id).unwrap();
        assert_eq!(info.line_count, Some(1));
        assert_eq!(info.max_line_bytes, Some((999 * 1024) as u64));
        let page = store.read_lines(&giant.id, None, 1000).unwrap();
        assert!(page.bytes_read <= LINE_PAGE_BYTES as u64);
        assert!(page.segments.len() <= 1000);
        assert!(page
            .segments
            .iter()
            .all(|segment| segment.byte_length <= LINE_SEGMENT_BYTES as u64));
        assert!(page
            .segments
            .iter()
            .all(|segment| segment.line_start_offset == Some(0)));
        assert!(page
            .segments
            .iter()
            .all(|segment| segment.continues_to_next));

        let many = store
            .create_staging(ContentMetadata {
                media_type: Some("text/plain".into()),
                charset: Some("utf-8".into()),
            })
            .unwrap();
        let payload = "x\n".repeat(2_000_000);
        store.append(&many.id, payload.as_bytes()).unwrap();
        store.finish(&many.id).unwrap();
        let info = store.inspect(&many.id).unwrap();
        assert_eq!(info.line_count, Some(2_000_001));
        assert_eq!(info.max_line_bytes, Some(1));
        let page = store.read_lines(&many.id, None, 1000).unwrap();
        assert_eq!(page.segments.len(), 1000);
        assert_eq!(page.bytes_read, 2000);
        assert!(page.segments.iter().all(|segment| segment.text == "x"));
        let preview = store.read_lines(&many.id, Some("preview:0"), 1000).unwrap();
        let next = store
            .read_lines(&many.id, preview.next_cursor.as_deref(), 1000)
            .unwrap();
        assert_eq!(preview.bytes_read, 2000);
        assert_eq!(next.offset, 2000);
        assert_eq!(next.segments.len(), 1000);
        assert!(next
            .segments
            .iter()
            .all(|segment| segment.hidden_bytes.is_none()));
    }

    #[test]
    fn preview_collapses_giant_lines_and_preserves_following_rows() {
        let (_directory, _root, mut store) = store(ResponseLimits::default());
        let reference = store
            .create_staging(ContentMetadata {
                media_type: Some("text/plain".into()),
                charset: Some("utf-8".into()),
            })
            .unwrap();
        let body = format!("first\n{}\npurr-tail-marker\n", "x".repeat(2 * 1024 * 1024));
        store.append(&reference.id, body.as_bytes()).unwrap();
        store.finish(&reference.id).unwrap();
        let page = store
            .read_lines(&reference.id, Some("preview:0"), 1000)
            .unwrap();
        assert!(page.complete);
        assert_eq!(page.bytes_read, body.len() as u64);
        assert_eq!(page.segments.len(), 3);
        assert_eq!(page.segments[1].hidden_bytes, Some(2 * 1024 * 1024 - 128));
        assert_eq!(page.segments[1].text.len(), 96);
        assert_eq!(page.segments[2].text, "purr-tail-marker");
        let first = store
            .read_lines(&reference.id, Some("preview:0"), 1)
            .unwrap();
        let second = store
            .read_lines(&reference.id, first.next_cursor.as_deref(), 1)
            .unwrap();
        assert_eq!(second.offset, 6);
        assert_eq!(second.segments.len(), 1);
        assert!(second.next_cursor.is_some());
        let search = store
            .search(
                &reference.id,
                &SearchQuery {
                    text: "purr-(tail|first)-marker".into(),
                    regular_expression: true,
                    case_sensitive: false,
                },
                None,
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(search.matches[0].byte_length, 16);
    }

    #[test]
    fn invalid_utf8_and_cancelled_or_unbounded_search_fail_cleanly() {
        let limits = ResponseLimits {
            max_content_bytes: 1024 * 1024,
            ..ResponseLimits::default()
        };
        let (_directory, _root, mut store) = store(limits);
        let reference = store
            .create_staging(ContentMetadata {
                media_type: Some("text/plain".into()),
                charset: None,
            })
            .unwrap();
        store.append(&reference.id, &[0xff, b'a', b'\n']).unwrap();
        store.finish(&reference.id).unwrap();
        assert!(store.read_lines(&reference.id, None, 10).is_err());

        let cancelled = AtomicBool::new(true);
        assert!(store
            .search(
                &reference.id,
                &SearchQuery {
                    text: "a".into(),
                    case_sensitive: false,
                    regular_expression: false,
                },
                None,
                &cancelled,
            )
            .unwrap_err()
            .contains("cancelled"));
        assert!(store
            .search(
                &reference.id,
                &SearchQuery {
                    text: "a+".into(),
                    case_sensitive: false,
                    regular_expression: true,
                },
                None,
                &AtomicBool::new(false),
            )
            .unwrap_err()
            .contains("Unbounded"));
    }

    #[test]
    fn large_format_and_query_results_use_releasable_derived_content() {
        let limits = ResponseLimits {
            max_content_bytes: 4 * 1024 * 1024,
            ..ResponseLimits::default()
        };
        let (_directory, _root, mut store) = store(limits);
        let reference = store
            .create_staging(ContentMetadata {
                media_type: Some("application/json".into()),
                charset: Some("utf-8".into()),
            })
            .unwrap();
        let json = serde_json::to_vec(&serde_json::json!({
            "payload": "x".repeat(INLINE_OPERATION_RESULT_BYTES + 32)
        }))
        .unwrap();
        store.append(&reference.id, &json).unwrap();
        store.finish(&reference.id).unwrap();

        for result in [
            store
                .format(
                    &reference.id,
                    &FormatRequest {
                        syntax: "json".into(),
                        indent: 2,
                    },
                    &AtomicBool::new(false),
                )
                .unwrap(),
            store
                .query(
                    &reference.id,
                    &JsonQueryRequest {
                        language: "jq".into(),
                        expression: ".payload".into(),
                    },
                    &AtomicBool::new(false),
                )
                .unwrap(),
        ] {
            let ContentOperationResult::Content { reference } = result else {
                panic!("large operation result must use a content reference");
            };
            assert!(store.inspect(&reference.id).is_ok());
            store.release(&reference.id).unwrap();
            assert!(store.inspect(&reference.id).is_err());
        }
    }

    #[test]
    fn json_and_ndjson_above_the_full_tree_tier_use_streaming_adapters() {
        let limits = ResponseLimits {
            max_content_bytes: 64 * 1024 * 1024,
            ..ResponseLimits::default()
        };
        let (_directory, _root, mut store) = store(limits);
        let json_reference = store
            .create_staging(ContentMetadata {
                media_type: Some("application/json".into()),
                charset: Some("utf-8".into()),
            })
            .unwrap();
        let json = format!(
            "{{\"meta\":{{\"fixture\":\"purr-synthetic\"}},\"payload\":\"{}\"}}",
            "x".repeat(STRUCTURED_PARSE_BYTES as usize + 1024)
        );
        store.append(&json_reference.id, json.as_bytes()).unwrap();
        store.finish(&json_reference.id).unwrap();
        drop(json);
        for (language, expression) in [("jq", ".meta.fixture"), ("jsonpath", "$.meta.fixture")] {
            assert_eq!(
                store
                    .query(
                        &json_reference.id,
                        &JsonQueryRequest {
                            language: language.into(),
                            expression: expression.into(),
                        },
                        &AtomicBool::new(false),
                    )
                    .unwrap(),
                ContentOperationResult::Value {
                    value: serde_json::json!("purr-synthetic")
                }
            );
        }
        assert!(store
            .query(
                &json_reference.id,
                &JsonQueryRequest {
                    language: "jsonpath".into(),
                    expression: "$..fixture".into(),
                },
                &AtomicBool::new(false),
            )
            .unwrap_err()
            .contains("full response tree"));
        let formatted = store
            .format(
                &json_reference.id,
                &FormatRequest {
                    syntax: "json".into(),
                    indent: 2,
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        let ContentOperationResult::Content { reference } = formatted else {
            panic!("large formatted JSON must stay native");
        };
        store.release(&reference.id).unwrap();

        let ndjson_reference = store
            .create_staging(ContentMetadata {
                media_type: Some("application/x-ndjson".into()),
                charset: Some("utf-8".into()),
            })
            .unwrap();
        let line = format!(
            "{{\"meta\":{{\"fixture\":\"purr-synthetic\"}},\"payload\":\"{}\"}}\n",
            "x".repeat(1024 * 1024)
        );
        let ndjson = line.repeat(33);
        assert!(ndjson.len() as u64 > STRUCTURED_PARSE_BYTES);
        store
            .append(&ndjson_reference.id, ndjson.as_bytes())
            .unwrap();
        store.finish(&ndjson_reference.id).unwrap();
        drop(ndjson);
        let queried = store
            .query(
                &ndjson_reference.id,
                &JsonQueryRequest {
                    language: "jsonpath".into(),
                    expression: "$.meta.fixture".into(),
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        let ContentOperationResult::Value { value } = queried else {
            panic!("small NDJSON query output should cross IPC as a value");
        };
        assert_eq!(value.as_array().map(Vec::len), Some(33));
    }

    #[test]
    fn incomplete_and_expired_content_is_unreadable_and_cleaned() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 0,
        };
        let (_directory, _root, mut store) = store(limits);
        let reference = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&reference.id, b"partial").unwrap();
        assert!(store.inspect(&reference.id).is_err());
        assert_eq!(store.cleanup_expired(i64::MAX).unwrap(), 1);
        assert!(store.finish(&reference.id).is_err());
    }

    #[test]
    fn quota_and_content_limits_fail_before_committing_more_chunks() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 8,
            max_retained_bytes: Some(10),
            staging_ttl_seconds: 60,
        };
        let (_directory, _root, mut store) = store(limits);
        let first = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&first.id, b"12345678").unwrap();
        assert!(store.append(&first.id, b"9").is_err());
        let second = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        assert!(store.append(&second.id, b"abc").is_err());
        assert_eq!(store.finish(&first.id).unwrap().byte_length, 8);
    }

    #[test]
    fn ciphertext_tampering_reordering_and_missing_chunks_fail_closed() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 60,
        };
        let (_directory, _root, mut store) = store(limits);
        let reference = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&reference.id, b"abcdefghijkl").unwrap();
        store.finish(&reference.id).unwrap();
        store.db.execute("UPDATE response_content_chunks SET ciphertext=zeroblob(length(ciphertext)) WHERE content_id=?1 AND chunk_index=0", [&reference.id]).unwrap();
        assert!(store
            .read_range(
                &reference.id,
                ByteRange {
                    offset: 0,
                    length: 4
                },
                "text"
            )
            .is_err());

        let reordered = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&reordered.id, b"abcdefghijkl").unwrap();
        store.finish(&reordered.id).unwrap();
        store.db.execute("UPDATE response_content_chunks SET plain_offset=99 WHERE content_id=?1 AND chunk_index=1", [&reordered.id]).unwrap();
        assert!(store
            .read_range(
                &reordered.id,
                ByteRange {
                    offset: 0,
                    length: 12
                },
                "text"
            )
            .is_err());

        let missing = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&missing.id, b"abcdefghijkl").unwrap();
        store.finish(&missing.id).unwrap();
        store
            .db
            .execute(
                "DELETE FROM response_content_chunks WHERE content_id=?1 AND chunk_index=1",
                [&missing.id],
            )
            .unwrap();
        assert!(store
            .read_range(
                &missing.id,
                ByteRange {
                    offset: 0,
                    length: 12
                },
                "text"
            )
            .is_err());
    }

    #[test]
    fn plaintext_never_appears_in_the_database_and_migration_is_idempotent() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 60,
        };
        let (directory, root, mut store) = store(limits);
        let marker = b"purr-sensitive-response-marker";
        let reference = store
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        store.append(&reference.id, marker).unwrap();
        store.finish(&reference.id).unwrap();
        drop(store);
        let database = std::fs::read(directory.path().join("state.db")).unwrap();
        assert!(!database
            .windows(marker.len())
            .any(|window| window == marker));
        let reopened = ResponseContentStore::open_with_limits(
            &directory.path().join("state.db"),
            &root,
            limits,
        )
        .unwrap();
        assert_eq!(
            reopened.inspect(&reference.id).unwrap().size,
            marker.len() as u64
        );
        assert_eq!(
            reopened
                .db
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            4
        );
    }

    #[test]
    fn persistence_adopts_content_atomically_and_execution_deletion_cascades() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 60,
        };
        let (directory, root, mut content) = store(limits);
        let reference = content
            .create_staging(ContentMetadata {
                media_type: Some("application/json".into()),
                charset: Some("utf-8".into()),
            })
            .unwrap();
        content.append(&reference.id, b"{\"ok\":true}").unwrap();
        let reference = content.finish(&reference.id).unwrap();
        let workspace_reference = content
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        content
            .append(&workspace_reference.id, b"workspace")
            .unwrap();
        let workspace_reference = content.finish(&workspace_reference.id).unwrap();
        drop(content);

        let mut local = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        let record = LocalRecord {
            table: "request_executions".into(),
            id: "execution_1".into(),
            value: serde_json::json!({
                "documentId":"request",
                "response":{
                    "protocolVersion":2,
                    "response":{"status":200},
                    "content":reference,
                    "timeline":{"startedAtMs":1}
                }
            }),
        };
        local.write("workspace", &[record]).unwrap();
        local
            .write(
                "other_workspace",
                &[LocalRecord {
                    table: "request_executions".into(),
                    id: "execution_2".into(),
                    value: serde_json::json!({
                        "documentId":"request",
                        "response":{
                            "protocolVersion":2,
                            "response":{"status":200},
                            "content":workspace_reference,
                            "timeline":{"startedAtMs":2}
                        }
                    }),
                }],
            )
            .unwrap();
        assert_eq!(
            local
                .db
                .query_row(
                    "SELECT state FROM response_contents WHERE id=?1",
                    [&reference.id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "adopted"
        );

        local
            .write(
                "workspace",
                &[LocalRecord {
                    table: "request_executions".into(),
                    id: "execution_1".into(),
                    value: serde_json::Value::Null,
                }],
            )
            .unwrap();
        assert_eq!(
            local
                .db
                .query_row("SELECT COUNT(*) FROM response_contents", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        local
            .register("other_workspace", &directory.path().join("other_workspace"))
            .unwrap();
        local.delete_workspace("other_workspace").unwrap();
        assert_eq!(
            local
                .db
                .query_row("SELECT COUNT(*) FROM response_contents", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn failed_execution_commit_rolls_back_content_adoption() {
        let limits = ResponseLimits {
            chunk_bytes: 4,
            max_window_bytes: 32,
            max_content_bytes: 64,
            max_retained_bytes: None,
            staging_ttl_seconds: 60,
        };
        let (directory, root, mut content) = store(limits);
        let reference = content
            .create_staging(ContentMetadata {
                media_type: None,
                charset: None,
            })
            .unwrap();
        content.append(&reference.id, b"body").unwrap();
        let reference = content.finish(&reference.id).unwrap();
        drop(content);
        let mut local = LocalStateStore::open(&directory.path().join("state.db"), &root).unwrap();
        let execution = LocalRecord {
            table: "request_executions".into(),
            id: "execution_1".into(),
            value: serde_json::json!({"documentId":"request","response":{"protocolVersion":2,"response":{"status":200},"content":reference,"timeline":{"startedAtMs":1}}}),
        };
        let invalid = LocalRecord {
            table: "invalid".into(),
            id: "bad".into(),
            value: serde_json::json!({}),
        };
        assert!(local.write("workspace", &[execution, invalid]).is_err());
        assert_eq!(
            local
                .db
                .query_row(
                    "SELECT state FROM response_contents WHERE id=?1",
                    [&reference.id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "ready"
        );
    }
}
