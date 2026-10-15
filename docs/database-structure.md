# Структура локальних БД Purr та формат зашифрованих BLOB

Опис реалізації S05, станом на 2026-10-13. Документ пояснює native storage, явне розділення public/protected записів та їх перегляд через DBeaver.

## 1. Де знаходяться дані

Основна директорія — Tauri app-data для конкретного bundle ID. У macOS це зазвичай `~/Library/Application Support/<bundle-id>/`. Dev використовує `com.ihorpolishchuk.purr`, production — `com.usepurr.purr`. Debug/release збірки з однаковим bundle ID використовують однакове сховище.

```text
<app-data>/
├── projects/<workspace-id>/     переносимі YAML та assets
├── local-state.sqlite3          основна локальна БД, schema version 8
├── scope-keys.sqlite3           реєстр захищених ключів, schema version 1
├── root-key-metadata-v1.json    ідентичність OS root та keycheck
├── root-key-manager.lock       блокування активного native профілю
├── storage-layout.lock         блокування підготовки розташування
├── storage-layout-v3.json      завершена підготовка розташування
└── deprecated/<unique-id>/     попередні managed datasets
```

Біля кожної SQLite можуть існувати `-wal`, `-shm` та іноді `-journal`. Це службові файли SQLite. WAL може містити вже закомічені зміни, ще не перенесені в основний файл. Копія одного `.sqlite3` під час роботи застосунку не обов'язково є повною копією даних.

`storage-layout-transition-v3.json` існує під час перенесення попереднього сховища. Він містить список назв та місце архівування; після успіху стає `storage-layout-v3.json`. Жоден layout manifest не містить ключів. Попередні `development/`, `release/` та експериментальна `storage-v2/` також архівуються. Зовнішні attached project folders не переміщуються. Архівована БД має історичні шляхи каталогу й не відкривається автоматично як новий активний профіль.

`projects` — файлове представлення workspace. Runtime workspace додатково включає локальні вкладки, drafts, історію, cookies та кеші в SQLite. Збережені запити, environments та конфігурації лежать у YAML, а не лише в БД.

## 2. Що саме зашифровано

Це звичайна SQLite із шифруванням окремих значень застосунком, не SQLCipher. DBeaver бачить схему, таблиці, індекси, службові колонки та BLOB. Наявність BLOB сама по собі означає лише тип «байти»; у перелічених нижче protected колонках ці байти мають описаний криптографічний формат.

S05 використовує явну колонку `protection`: `plaintext` або `encrypted`. UI/session та очищені робочі копії можуть бути відкритим JSON; credentials і виділені sensitive fragments залишаються у `secret_values`. Cookies, OAuth runtime та приватні attachments захищені незалежно від Encrypt responses. Позначення sensitive та вибір шифрування всієї відповіді — різні речі.

Encrypt responses має локальний workspace default Off і request override Inherit/On/Off. Off дозволяє відкриті звичайні response body/metadata; On захищає їх runtime key. Політика фіксується при dispatch. Існуючі entries/chunks зберігають власну protection після перемикання. Довільний server body може містити токен або персональні дані: Purr не сканує його вміст. Cookie/Set-Cookie та відомі OAuth token responses залишаються захищеними.

S05 починає новий dataset у корені app-data. Попередній S04 набір — managed projects, обидві SQLite з sidecars, root metadata та попередні layout manifests — цілісно переміщується в `deprecated/<unique-id>`. Schema 7 не перетворюється на schema 8. Старі OS Keychain entries зберігаються; новий профіль має identity `application-v3`. Старі external project directories не чіпаються. При явному підключенні YAML локальні defaults починаються з Off, а відсутні секрети вводяться вручну.

Не приховуються всі метадані. Каталог workspace та шляхи, SecretRef, ID, ревізії, деякі timestamps/status, розміри response chunks і cookie attributes доступні без ключа. Заголовки криптографічних envelopes також відкриті, але автентифіковані. Копія директорії розкриває ці метадані, проте не містить відкритого нового installation root.

## 3. `local-state.sqlite3`

### 3.1 Каталог і службові налаштування

| Таблиця | Колонки | Призначення |
|---|---|---|
| `migrations` | `version` INTEGER PK, `applied_at` TEXT | Журнал версій схеми |
| `app_state` | `key` TEXT PK, `value` TEXT | Наприклад `active-workspace`, `crypto-key-derivation=mixed-scoped-v3`, retention settings |
| `workspaces` | `id` TEXT PK, `directory` TEXT UNIQUE | Зв'язок workspace ID із managed або зовнішньою project directory |

Поточний `PRAGMA user_version` — **8**. Схема не дорівнює версії canonical YAML або версії криптографічного envelope.

### 3.2 Основні локальні записи

Вісім таблиць мають спільну базову форму:

```sql
workspace_id TEXT NOT NULL,
id TEXT NOT NULL,
payload BLOB NOT NULL,
protection TEXT NOT NULL DEFAULT 'encrypted'
  CHECK(protection IN ('plaintext', 'encrypted')),
updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
PRIMARY KEY(workspace_id, id)
```

| Таблиця | Що знаходиться всередині JSON `payload` після декодування protection |
|---|---|
| `workspace_local_state` | JSON локальних налаштувань. Наприклад записи `state`, `dynamic-variable-cache`, `auth-runtime`. Global variables — запис `variables` із власником `__global__`. Для явно відкритого v1 project може існувати `legacy-definition-draft` |
| `drafts` | JSON робочої копії документа, включно з незбереженими змінами; runtime credentials представлені захищеними references |
| `document_session_state` | JSON стану редактора, UI, timestamps та локальних атрибутів документа |
| `request_executions` | JSON незмінної history entry, request/response metadata та references на body; додаткові колонки описані нижче |
| `cookie_jar` | JSON cookie record зі значенням cookie |
| `schema_cache` | JSON кешу GraphQL: SDL, час завантаження, cache identity та definition hash |
| `recent_items` | Локальні recent records; наявність таблиці не означає, що вона завжди заповнена |
| `attachments` | JSON attachment record: `version`, `name`, `type`, `lastModified`, `size`, `base64` |

`protection=plaintext` означає UTF-8 JSON без crypto envelope; `encrypted` означає scoped envelope v2, після розшифрування якого отримуємо UTF-8 JSON. Reader вибирає шлях за колонкою, не за першим байтом або помилкою decrypt. Це спеціалізовані DTO, не одна серіалізована копія всього runtime `Workspace`. Форма JSON залежить від таблиці та типу запису.

Локальні HTTP/GraphQL editors у `drafts.request`, `drafts.savedRequest`, `document_session_state.editor` та `request_executions.editor` мають компактний формат із `__purrRequest: 1`. Наприклад, звичайний GET без додаткових налаштувань зберігається так:

```json
{"__purrRequest":1,"method":"GET","url":"http://127.0.0.1:18765/echo"}
```

Версія фіксує defaults: порожні Body/Auth, один стандартний порожній рядок params/headers, порожні pathParams, увімкнені cookies та стандартні request inheritance overrides відновлюються при читанні. Зберігаються лише відмінності, включно з вкладеними полями auth/body. Це не видалення неактивних режимів: задані значення, disabled rows, дублікати, нестандартні ID, файли й індивідуальні overrides залишаються. Невикористаний автоматично створений multipart boundary можна відновити; активний/налаштований body і власний boundary зберігаються. Defaults цього формату незалежні від майбутніх UI defaults.

Secret envelopes створюються **до** ущільнення; повна структура editor відновлюється **до** читання секретів, тому missing/unavailable не губляться. Повний попередній JSON читається без конвертації. Нові записи компактні; існуюча історія не переписується масово. Для dirty document session не дублює editor, який уже належить draft. `savedRequest` залишається baseline для Discard. Clean session використовує `definitionHash` замість копії YAML; schema session — `authDefinitionHash`. У `schema_cache` v2 source береться з canonical definition, тому старе дублююче поле більше не записується.

На синтетичному GET із прикладу JSON editor зменшується з 1020 до 70 UTF-8 байтів (приблизно 93%). Це розмір конкретного editor payload, а не всієї SQLite БД чи гарантія прискорення запуску. Після видалення/заміни старих payloads SQLite може повторно використовувати сторінки без зменшення розміру файла.

Owner `__global__` позначає global runtime storage. У SecretRef глобальний owner має ім'я `global`. Для звичайного workspace ці імена зарезервовані.

### 3.3 Історія та response bodies

`request_executions` розширює базову форму:

| Колонка | Вміст |
|---|---|
| `document_id` TEXT nullable | Документ-власник виконання |
| `started_at` INTEGER nullable | Час виконання в мілісекундах Unix epoch |
| `status` INTEGER nullable | HTTP status для відповідних виконань |
| `pinned` INTEGER DEFAULT 0 | Закріплення, що виключає автоматичне expiry |
| `summary` BLOB nullable | JSON короткого опису історії; використовує protection execution |

Індекси: `execution_document_time(workspace_id, document_id, started_at DESC)` і `execution_workspace_time(workspace_id, started_at DESC, id DESC)`.

Summary містить такі поля, як name, method, URL, outcome, status, size та необов'язкове provenance dynamic execution. Список історії читає summary; тіло відповіді не потрібне для звичайного переліку. Текстовий пошук перевіряє декодовані summaries у Rust, а не SQL `LIKE` усередині ciphertext. Публічний snapshot із Off не містить classified wire values: точні sensitive request/response fields знаходяться за immutable `protectedSnapshot` runtime SecretRef. Зміна поточного токена не змінює history snapshot.

`response_bodies(workspace_id, execution_id, payload BLOB, protection TEXT)` із composite PK — попередній inline body формат. Payload — JSON із `text`/`bodyBase64`, відкритий або encrypted згідно з protection. Новий native streaming шлях використовує наступні таблиці.

**`response_contents` — метадані одного body:**

| Колонка | Тип / значення |
|---|---|
| `id` | TEXT PK; opaque content ID |
| `workspace_id` | TEXT; у поточному native flow owner встановлюється до першого chunk, хоча SQL column залишається nullable |
| `execution_id` | TEXT nullable; встановлюється при adoption історією |
| `state` | TEXT: `staging`, `ready`, `adopted` |
| `byte_length` | INTEGER ≥ 0 |
| `media_type`, `charset` | TEXT nullable; заповнені лише для plaintext content |
| `protection` | TEXT: `plaintext` або `encrypted`; задається до першого chunk |
| `metadata` | BLOB nullable; encrypted mediaType/charset для On, NULL для Off |
| `created_at`, `expires_at` | INTEGER Unix epoch seconds; expiry nullable |

Є UNIQUE `(workspace_id, execution_id)` та індекс `response_contents_expiry(state, expires_at)`.

**`response_content_chunks` — власне байти:**

| Колонка | Тип / значення |
|---|---|
| `content_id` | TEXT FK → `response_contents.id`, ON DELETE CASCADE |
| `chunk_index` | INTEGER ≥ 0 |
| `plain_offset` | INTEGER ≥ 0; позиція у початковому body |
| `plain_length` | INTEGER > 0; розмір до шифрування |
| `crypto_version` | INTEGER: 2 для scoped content, 0 для plaintext content |
| `nonce` | BLOB: 12 bytes для encrypted, порожній для plaintext |
| `ciphertext` | BLOB: encrypted envelope fragment або сирі body bytes для plaintext; історична назва колонки |

PK `(content_id, chunk_index)`, UNIQUE `(content_id, plain_offset)`. За `response_contents.protection=encrypted` chunk розшифровується, за `plaintext` reader додатково вимагає `crypto_version=0` і порожній nonce. Результат — **сирі байти response body**, не JSON-обгортка. Невідомий discriminator або суперечливий chunk відхиляється, decrypt error не запускає plaintext fallback. Наприклад JSON response лишається JSON байтами, PNG — PNG байтами.

`staging` означає запис у процесі; `ready` — завершений тимчасовий content; `adopted` — content належить збереженій history entry. Видалення execution прибирає відповідний content та chunks. Derived format/query results також можуть створювати тимчасові `ready` records; вони успадковують protection та workspace фактичного source content.

### 3.4 Cookies та attachments

`cookie_metadata` має composite PK `(workspace_id, id)` та відкриті колонки `name`, `domain`, `path`, `expires`, `secure`, `http_only`, `same_site`, `host_only`, `enabled`. Індекс — `cookie_domain_path(workspace_id, domain, path)`. Cookie value знаходиться у protected `cookie_jar.payload`.

`history_attachments(workspace_id, id, payload BLOB, protection TEXT)` має composite PK; це захищені копії attachments, які потрібні для replay історії після видалення live draft.

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
| `pending_commits` | `workspace_id` TEXT PK, `payload` BLOB, `protection` TEXT | JSON журналу file/local/secret publication та відновлення |
| `secret_operations` | `operation_id` TEXT PK, `state` TEXT, `payload` BLOB, `protection` TEXT | JSON receipt: fingerprint запиту та result; replay material знаходиться в pending journal |
| `workspace_cleanup` | `workspace_id` TEXT PK, `payload` BLOB, `protection` TEXT | JSON intent завершення очищення managed directory |

Operation states: `prepared`, `applying`, `committed`, `aborted`, `recovery-required`. Protected записи використовують installation journal scope. Journal із secret mutations або encrypted local changes завжди encrypted. Суто public commit може мати plaintext journal і receipt без доступу до ключа. Receipt містить SHA-256 request fingerprint та result, а не значення секретів. Terminal receipts забезпечують повторювану перевірку результату операції.

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

### 5.0 Як вибрати формат

Спочатку дивись `protection`, потім структуру BLOB. Для `plaintext` local `payload`/`summary` — звичайні UTF-8 JSON bytes без version byte; для body chunk — сирі response bytes. Для `encrypted` застосовуються формати нижче. `secret_values` та wrapped keys не мають public варіанта.

Приклад public draft: BLOB із байтами `{"version":1,...}`. Захищені поля всередині такого DTO представлені refs, а не literal секретами. Це не SQLCipher: всю SQLite не можна класифікувати за одним заголовком.

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
| Response content metadata | `purr:response-content-metadata:v3\|<workspace>\|<content-id>` |
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
SELECT workspace_id, id, protection, length(payload) AS blob_bytes,
       hex(substr(payload, 1, 17)) AS version_nonce_header_length
FROM drafts;

-- Читабельний JSON тільки для явно public rows:
SELECT workspace_id, id, CAST(payload AS TEXT) AS public_json
FROM drafts WHERE protection = 'plaintext';

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

S05 прибирає AES-GCM overhead для public rows/chunks, але зберігає серіалізацію JSON, SQLite IO і bounded streaming. On та всі classified fragments продовжують використовувати AES-GCM. Сам факт меншої кількості crypto operations не є benchmark; порівнювати треба однакові synthetic fixtures та workload.

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

Browser preview використовує новий IndexedDB `purr-preview-v4`, зберігаючи стару v3 без змін. Local container має `{version:1, records:[...]}`; кожен row має table/id та `{version:1, protection:"plaintext", value}` або `{version:1, protection:"encrypted", envelope}`. Browser WebCrypto envelope містить scope/keyId/context/iv/data; це не native binary layout. Public history index має мінімальні redacted summaries для On, окремі encrypted summary records повертають деталі при доступному ключі. Unavailable records позначаються типізовано і зберігаються при public save. Для нього дивись `src/storage/browser-crypto.ts` і `browser-backend.ts`.

## Перенесення секретів і recovery (S06)

Нових таблиць або нового формату SQLite немає. Вибірковий імпорт використовує наявні `secret_values`, revisions, journal та receipts, із CAS-перевіркою ідентичності й ревізій. Значення шифруються чинним credential key пристрою-одержувача. Drafts, request_executions, cookies та runtime keys не переносяться.

Recovery key package містить тільки ключі credential scope обраного workspace. Окремий credential backup містить відповідні encrypted rows (`reference`, crypto version, nonce, ciphertext), відібрані за збереженими деклараціями. Це версійований пакет, а не SQLite backup. Секрети відновлюються тимчасовими source keys і повторно шифруються destination keys; активний registry не замінюється. Опис зовнішнього контейнера, форматів і меж — [Secret transfer and recovery](secret-transfer-and-recovery.md).
