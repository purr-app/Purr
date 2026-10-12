# Структура локальних БД Purr та формат зашифрованих BLOB

Опис поточної реалізації S04, станом на 2026-10-13. Документ пояснює native storage, який можна переглядати через DBeaver. Подальші зміни політики Encrypt responses мають оновлювати цей опис.

## 1. Де знаходяться дані

Основна директорія — Tauri app-data для конкретного bundle ID. У macOS це зазвичай `~/Library/Application Support/<bundle-id>/`. Dev використовує `com.ihorpolishchuk.purr`, production — `com.usepurr.purr`. Debug/release збірки з однаковим bundle ID використовують однакове сховище.

```text
<app-data>/
├── projects/<workspace-id>/     переносимі YAML та assets
├── local-state.sqlite3          основна локальна БД, schema version 7
├── scope-keys.sqlite3           реєстр захищених ключів, schema version 1
├── root-key-metadata-v1.json    ідентичність OS root та keycheck
├── root-key-manager.lock       блокування активного native профілю
├── storage-layout.lock         блокування підготовки розташування
├── storage-layout-v2.json      завершена підготовка розташування
└── deprecated/<unique-id>/     попередні managed datasets
```

Біля кожної SQLite можуть існувати `-wal`, `-shm` та іноді `-journal`. Це службові файли SQLite. WAL може містити вже закомічені зміни, ще не перенесені в основний файл. Копія одного `.sqlite3` під час роботи застосунку не обов'язково є повною копією даних.

`storage-layout-transition.json` існує під час перенесення попереднього сховища. Він містить список назв та місце архівування; після успіху стає `storage-layout-v2.json`. Жоден layout manifest не містить ключів. Попередні `development/`, `release/` та експериментальна `storage-v2/` також архівуються. Зовнішні attached project folders не переміщуються. Архівована БД має історичні шляхи каталогу й не відкривається автоматично як новий активний профіль.

`projects` — файлове представлення workspace. Runtime workspace додатково включає локальні вкладки, drafts, історію, cookies та кеші в SQLite. Збережені запити, environments та конфігурації лежать у YAML, а не лише в БД.

## 2. Що саме зашифровано

Це звичайна SQLite із шифруванням окремих значень застосунком, не SQLCipher. DBeaver бачить схему, таблиці, індекси, службові колонки та BLOB. Наявність BLOB сама по собі означає лише тип «байти»; у перелічених нижче protected колонках ці байти мають описаний криптографічний формат.

У поточній версії credentials, drafts, cookies, session state, history, attachments і всі response bodies захищені. Продуктова ознака sensitive та факт шифрування локального runtime state — різні речі. Звичайний draft шифрується runtime key, але не стає SecretRef у canonical YAML.

Не приховуються всі метадані. Каталог workspace та шляхи, SecretRef, ID, ревізії, деякі timestamps/status, розміри response chunks і cookie attributes доступні без ключа. Заголовки криптографічних envelopes також відкриті, але автентифіковані. Копія директорії розкриває ці метадані, проте не містить відкритого нового installation root.

## 3. `local-state.sqlite3`

### 3.1 Каталог і службові налаштування

| Таблиця | Колонки | Призначення |
|---|---|---|
| `migrations` | `version` INTEGER PK, `applied_at` TEXT | Журнал версій схеми |
| `app_state` | `key` TEXT PK, `value` TEXT | Наприклад `active-workspace`, `crypto-key-derivation=scoped-envelope-v2`, retention settings |
| `workspaces` | `id` TEXT PK, `directory` TEXT UNIQUE | Зв'язок workspace ID із managed або зовнішньою project directory |

Поточний `PRAGMA user_version` — **7**. Схема не дорівнює версії canonical YAML або версії криптографічного envelope.

### 3.2 Основні локальні записи

Вісім таблиць мають спільну базову форму:

```sql
workspace_id TEXT NOT NULL,
id TEXT NOT NULL,
payload BLOB NOT NULL,
updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
PRIMARY KEY(workspace_id, id)
```

| Таблиця | Що знаходиться всередині розшифрованого `payload` |
|---|---|
| `workspace_local_state` | JSON локальних налаштувань. Наприклад записи `state`, `dynamic-variable-cache`, `auth-runtime`. Global variables — запис `variables` із власником `__global__`. Для явно відкритого v1 project може існувати `legacy-definition-draft` |
| `drafts` | JSON робочої копії документа, включно з незбереженими змінами; runtime credentials представлені захищеними references |
| `document_session_state` | JSON стану редактора, UI, timestamps та локальних атрибутів документа |
| `request_executions` | JSON незмінної history entry, request/response metadata та references на body; додаткові колонки описані нижче |
| `cookie_jar` | JSON cookie record зі значенням cookie |
| `schema_cache` | JSON кешу GraphQL: SDL, час завантаження, source, cache identity та definition hash |
| `recent_items` | Локальні recent records; наявність таблиці не означає, що вона завжди заповнена |
| `attachments` | JSON attachment record: `version`, `name`, `type`, `lastModified`, `size`, `base64` |

Розшифрування `payload` дає UTF-8 JSON. Це спеціалізовані DTO, не одна серіалізована копія всього runtime `Workspace`. Форма JSON залежить від таблиці та типу запису.

Owner `__global__` позначає global runtime storage. У SecretRef глобальний owner має ім'я `global`. Для звичайного workspace ці імена зарезервовані.

### 3.3 Історія та response bodies

`request_executions` розширює базову форму:

| Колонка | Вміст |
|---|---|
| `document_id` TEXT nullable | Документ-власник виконання |
| `started_at` INTEGER nullable | Час виконання в мілісекундах Unix epoch |
| `status` INTEGER nullable | HTTP status для відповідних виконань |
| `pinned` INTEGER DEFAULT 0 | Закріплення, що виключає автоматичне expiry |
| `summary` BLOB nullable | Зашифрований JSON короткого опису історії |

Індекси: `execution_document_time(workspace_id, document_id, started_at DESC)` і `execution_workspace_time(workspace_id, started_at DESC, id DESC)`.

Summary містить такі поля, як name, method, URL, outcome, status, size та необов'язкове provenance dynamic execution. Список історії читає summary; тіло відповіді не потрібне для звичайного переліку. Текстовий пошук перевіряє розшифровані summaries у Rust, а не SQL `LIKE` усередині ciphertext.

`response_bodies(workspace_id, execution_id, payload BLOB)` із composite PK — попередній inline body формат. Payload є зашифрованим JSON з `text`/`bodyBase64`. Новий native streaming шлях використовує наступні таблиці.

**`response_contents` — метадані одного body:**

| Колонка | Тип / значення |
|---|---|
| `id` | TEXT PK; opaque content ID |
| `workspace_id` | TEXT; у поточному native flow owner встановлюється до першого chunk, хоча SQL column залишається nullable |
| `execution_id` | TEXT nullable; встановлюється при adoption історією |
| `state` | TEXT: `staging`, `ready`, `adopted` |
| `byte_length` | INTEGER ≥ 0 |
| `media_type`, `charset` | TEXT nullable |
| `created_at`, `expires_at` | INTEGER epoch milliseconds; expiry nullable |

Є UNIQUE `(workspace_id, execution_id)` та індекс `response_contents_expiry(state, expires_at)`.

**`response_content_chunks` — власне байти:**

| Колонка | Тип / значення |
|---|---|
| `content_id` | TEXT FK → `response_contents.id`, ON DELETE CASCADE |
| `chunk_index` | INTEGER ≥ 0 |
| `plain_offset` | INTEGER ≥ 0; позиція у початковому body |
| `plain_length` | INTEGER > 0; розмір до шифрування |
| `crypto_version` | INTEGER; зараз 2 для scoped content |
| `nonce` | BLOB, 12 bytes |
| `ciphertext` | BLOB; header + encrypted bytes + authentication tag |

PK `(content_id, chunk_index)`, UNIQUE `(content_id, plain_offset)`. Після розшифрування chunk отримуємо **сирі байти response body**, не JSON-обгортку. Наприклад JSON response лишається JSON байтами, PNG — PNG байтами.

`staging` означає запис у процесі; `ready` — завершений тимчасовий content; `adopted` — content належить збереженій history entry. Видалення execution прибирає відповідний content та chunks. Derived format/query results також можуть створювати тимчасові `ready` records.

### 3.4 Cookies та attachments

`cookie_metadata` має composite PK `(workspace_id, id)` та відкриті колонки `name`, `domain`, `path`, `expires`, `secure`, `http_only`, `same_site`, `host_only`, `enabled`. Індекс — `cookie_domain_path(workspace_id, domain, path)`. Cookie value знаходиться у protected `cookie_jar.payload`.

`history_attachments(workspace_id, id, payload BLOB)` має composite PK; це захищені копії attachments, які потрібні для replay історії після видалення live draft.

`history_attachment_links(workspace_id, execution_id, attachment_id)` із composite PK пов'язує executions із retained attachments. Зв'язки відкриті; payload захищений. History attachment використовує той самий encryption context, що й live attachment, щоб можна було переносити ciphertext між цими власниками без повторного кодування файла.

### 3.5 Secret values та ревізії

| Таблиця | Колонки / призначення |
|---|---|
| `secret_values` | `reference` TEXT PK; `ciphertext` BLOB; `nonce` BLOB; `crypto_version` INTEGER; `created_at`, `updated_at` TEXT |
| `secret_revisions` | `reference` TEXT PK; `revision` INTEGER > 0 і ≤ 9007199254740991 |

Reference має форму `purr/<workspace-id>/credentials/<owner>/<field>` або `purr/<workspace-id>/runtime/<owner>/<field>`; для globals — `purr/global/...`.

Розшифроване значення secret — **UTF-8 рядок**, не обов'язково JSON. Auth token може бути рядком; integration auth використовує JSON, серіалізований у рядок. Reference є ідентичністю, не значенням секрету.

Тригери `secret_insert_revision`, `secret_update_revision`, `secret_delete_revision` збільшують ревізію при зміні. Після видалення value ревізія залишається tombstone. Це захищає від stale save, який міг би відновити видалений секрет. Порожній рядок — наявне значення; відсутній рядок `secret_values` — missing, збережена revision може залишатися.

### 3.6 Відновлення незавершених операцій

| Таблиця | Структура | Protected payload |
|---|---|---|
| `pending_commits` | `workspace_id` TEXT PK, `payload` BLOB | JSON журналу file/local/secret publication та відновлення |
| `secret_operations` | `operation_id` TEXT PK, `state` TEXT, `payload` BLOB | JSON receipt: fingerprint запиту та result; replay material знаходиться в pending journal |
| `workspace_cleanup` | `workspace_id` TEXT PK, `payload` BLOB | JSON intent завершення очищення managed directory |

Operation states: `prepared`, `applying`, `committed`, `aborted`, `recovery-required`. Ці записи використовують installation journal scope. У pending journal можуть бути секретні значення для відновлення, тому він також зашифрований. Terminal receipts забезпечують повторювану перевірку результату операції.

## 4. `scope-keys.sqlite3`

| Таблиця | Колонки | Призначення |
|---|---|---|
| `registry_identity` | `vault_id` TEXT, `keycheck` BLOB, `initialized` INTEGER | Перевіряє відповідність installation root реєстру; очікується один рядок |
| `protection_scopes` | `scope` TEXT PK, `active_key_id` TEXT | Активний ключ конкретної області |
| `wrapped_scope_keys` | `key_id` TEXT PK, `scope` TEXT, `identity` TEXT, `wrapped` BLOB, `keycheck` BLOB | Захищений 32-byte scope key та перевірка відповідності |

`scope` та `identity` — відкриті JSON strings. Вони не містять key bytes. Приклади scope:

```json
{"owner":"workspace","workspaceId":"alpha","kind":"credentials"}
{"owner":"workspace","workspaceId":"alpha","kind":"runtime"}
{"owner":"global","kind":"credentials"}
{"owner":"global","kind":"runtime"}
{"owner":"installation","kind":"journal"}
```

Workspace/global credential/runtime roots генеруються незалежно випадковими 32-byte ключами. Installation journal seed виводиться з нового OS root через окремий HKDF domain. Registry зберігає його wrapped запис так само, як інші scopes.

Нове сховище отримує installation root із macOS User Keychain. З нього HKDF-SHA256 виводить wrapping key (`purr:installation-wrapping:v2`) та journal seed (`purr:installation-journal:v2`). З кожного scope root виводяться purpose keys:

- `purr:scope:database:v2`;
- `purr:scope:secrets:v2`;
- `purr:scope:response-content:v2`.

Поточна функція HKDF використовує salt `purr:root-key:v1`; суфікс salt — історична назва, не версія envelope. `scope.kind` та `purpose` є різними рівнями: runtime secret value використовує runtime scope + secrets purpose, а draft — runtime scope + database purpose.

## 5. Точний формат BLOB

### 5.1 Єдина колонка `payload` або `summary`: scoped envelope v2

Порядок байтів, індекси від нуля:

| Offset | Довжина | Вміст |
|---|---|---|
| 0 | 1 | Version byte `0x02` |
| 1 | 12 | Випадковий AES-GCM nonce |
| 13 | 4 | Довжина header `N`, unsigned u32, **big-endian** |
| 17 | N | UTF-8 JSON header, відкритий та автентифікований |
| 17 + N | P | Encrypted plaintext bytes |
| 17 + N + P | 16 | AES-GCM authentication tag |

```text
02 | nonce[12] | headerLength[4, BE] | headerJSON[N] | encryptedBytes[P] | tag[16]
```

Приклад header, із синтетичними ID:

```json
{
  "version": 2,
  "algorithm": "aes-256-gcm",
  "key": {
    "vaultId": "synthetic-vault",
    "keyId": "synthetic-key",
    "generation": 1,
    "scope": {"owner":"workspace","workspaceId":"alpha","kind":"runtime"}
  },
  "purpose": "database"
}
```

На диску JSON компактний. Довжина — кількість UTF-8 **байтів**, не символів. Header може мати до 4096 bytes за поточним reader. Він показує, який ключ потрібен, але не містить ключа або plaintext payload. Generation зараз 1; формат підтримує її ідентифікацію, але завершеної користувацької ротації ключів ще немає.

Розмір цього envelope: `plaintextBytes + headerBytes + 33`. Шифрування не стискає дані. JSON/base64 attachment overhead існує ще до шифрування.

### 5.2 Secret та chunk: розділені SQL колонки

У `secret_values` та `response_content_chunks` перші 13 байтів не дублюються в `ciphertext`:

```text
crypto_version INTEGER = 2
nonce BLOB = 12 bytes
ciphertext BLOB = headerLength[4, BE] | headerJSON[N] | encryptedBytes[P] | tag[16]
```

Тому один `ciphertext` BLOB не починається з `0x02` і не містить nonce на початку. Щоб отримати формат попереднього розділу, потрібне логічне поєднання version byte, nonce та ciphertext. Сумарний overhead той самий.

### 5.3 Wrapped keys та keychecks: compact envelope v1

`wrapped_scope_keys.wrapped`, його `keycheck` та `registry_identity.keycheck` використовують низькорівневу обгортку:

```text
01 | nonce[12] | encryptedBytes[P] | tag[16]
```

Тут немає вкладеного JSON header. Key identity знаходиться в сусідніх колонках і входить у AAD. Розшифроване `wrapped` — 32 bytes scope root. Keycheck — відомий перевірочний рядок, не користувацький секрет. Сумарний overhead — 29 bytes. Наявність `0x01` у key registry не означає, що workspace data записані старим форматом.

### 5.4 AAD: чому BLOB не можна просто переставити

AAD — Additional Authenticated Data: відкритий контекст, який AES-GCM перевіряє разом із ciphertext. Він не зберігається окремою SQL колонкою; застосунок відтворює його з ідентичності запису.

Scoped envelope автентифікує **точні header bytes** та зовнішній context:

```text
purr:scope-envelope:v2|<headerByteLength>:<headerJSON>|<contextByteLength>:<context>
```

| Запис | Зовнішній context |
|---|---|
| Звичайний local record | `<workspace>/<table>/<id>` |
| History summary | `<workspace>/history-summary/<execution-id>` |
| Inline response body | `<workspace>/response_bodies/<execution-id>` |
| Secret value | `purr:secret:v1|<SecretRef>` |
| Response chunk | `purr:response-content:v2|<workspace>|<content-id>|<index>|<offset>|<plain-length>` |
| Pending commit | `<workspace>/journal` |
| Operation receipt | `purr:operation:v1|<operation-id>` |
| Cleanup intent | `purr:workspace-cleanup:v1|<workspace>` |
| Retained history attachment | `<workspace>/attachments/<attachment-id>` |

Wrapped scope key AAD: `purr:wrapped-scope-key:v2|<KeyIdentityJSON>`. Scope keycheck: `purr:scope-keycheck:v2|<KeyIdentityJSON>`. Registry keycheck: `purr:scope-registry:v2|<vault-id>`.

Перенесення payload в інший workspace/table/id, заміна nonce/header/tag або використання неправильного key/purpose провалює перевірку. Наявність читабельного JSON header у BLOB нормальна: конфіденційним є payload, а header захищений від непомітної зміни.

## 6. Як переглядати через DBeaver

Для дослідження використовуй read-only connection. Схему можна отримати без розшифрування:

```sql
PRAGMA user_version;
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type, name;
PRAGMA table_info('drafts');
PRAGMA index_list('request_executions');
PRAGMA foreign_key_list('response_content_chunks');
```

Приклади перегляду лише метаданих:

```sql
SELECT workspace_id, id, length(payload) AS blob_bytes,
       hex(substr(payload, 1, 17)) AS version_nonce_header_length
FROM drafts;

SELECT reference, crypto_version, length(nonce) AS nonce_bytes,
       length(ciphertext) AS envelope_bytes
FROM secret_values;

SELECT content_id, chunk_index, plain_offset, plain_length,
       crypto_version, length(ciphertext) AS envelope_bytes
FROM response_content_chunks
ORDER BY content_id, chunk_index;
```

SQLite `substr` має індексацію від **1**. Тому header length у цілісному payload — bytes 14–17 у SQL, а JSON починається з позиції 18. У split `ciphertext` length лежить на позиціях 1–4, JSON — від 5.

Для ілюстрації парсингу header без будь-якого розшифрування:

```python
import json

def payload_header(blob: bytes):
    if len(blob) < 33 or blob[0] != 2:
        raise ValueError("Expected scoped payload v2")
    size = int.from_bytes(blob[13:17], "big")
    if size > 4096 or len(blob) < 17 + size + 16:
        raise ValueError("Invalid envelope size")
    return json.loads(blob[17:17 + size].decode("utf-8"))
```

Це лише пояснення формату. DBeaver не має OS key manager та не перетворить protected payload у JSON самостійно. Не редагуй вручну protected IDs, refs, nonce, envelope або revision: вони беруть участь у перевірках і транзакційних гарантіях. SQL delete row також не відтворює весь application cleanup lifecycle.

## 7. Вплив на продуктивність

Шифрується окремий запис або chunk, а не вся БД після кожного натискання клавіші. Ключі та derived ciphers кешуються в процесі. Application projection порівнює зміни; native writer також може пропускати unchanged local payload після перевірки попереднього значення.

Великі responses мають chunks до 256 KiB, worker групує до 8 MiB в транзакцію, transport допускає до двох write batches in flight. Великі bodies не передаються цілком у WebView для звичайного відновлення/перегляду. Основні local commits використовують SQLite synchronous FULL, response content worker — NORMAL.

Обмеження: startup читає та розшифровує локальні записи workspace; великий змінений draft потребує серіалізації та повторного запису свого payload; пошук історії може перебирати багато encrypted summaries. Блокові responses обмежують streaming buffers, але не роблять всі JSON DTO, attachments або пошукові операції потоковими. Функціональні тести не є порівняльним benchmark S04.

S05 має додати політику зберігання звичайних responses та Encrypt responses. Credentials, cookies, OAuth runtime і відомі sensitive дані залишатимуться protected. Цей документ описує поточний encrypted-only response flow.

## 8. Джерела в репозиторії

- [Persistence architecture](persistence-architecture.md) — власники даних, commits, recovery.
- [local_records.rs](../src-tauri/src/persistence/local_records.rs) — main SQL schema та local payloads.
- [scoped.rs](../src-tauri/src/security/scoped.rs) — key registry, identity та scoped envelope.
- [security/mod.rs](../src-tauri/src/security/mod.rs) — AES-GCM primitives, nonce та compact envelope.
- [history.rs](../src-tauri/src/persistence/history.rs) — summary, пошук, retention.
- [content/store.rs](../src-tauri/src/content/store.rs) — response chunks, worker storage та AAD.
- [secret_commits.rs](../src-tauri/src/persistence/secret_commits.rs) — revision checks та receipts.
- [project-projection.ts](../src/application/project-projection.ts) — runtime DTO → canonical/local records.
- [layout.rs](../src-tauri/src/security/layout.rs) — deprecated archival manifests.

Browser preview використовує IndexedDB `purr-preview-v3` та WebCrypto envelopes; його формат відрізняється від наведеного native binary layout. Для нього дивись `src/storage/browser-crypto.ts` і `browser-backend.ts`.
