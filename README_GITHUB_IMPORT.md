# MDG BP Duplicate Checker — Cloudflare Pages GitHub Import

Versi ini dibuat khusus untuk deploy lewat **Cloudflare Pages → Import GitHub repository**.
Tidak perlu install Node.js di laptop. Tidak perlu Wrangler. Tidak perlu Direct Upload.

## Kenapa error sebelumnya muncul?

Error:

```text
SHEET_ID is not configured.
```

berarti Cloudflare runtime tidak menerima variable `SHEET_ID`. Pada versi GitHub ini sudah diperbaiki dengan dua lapisan:

1. `wrangler.toml` di root repo berisi `SHEET_ID` dan config non-secret.
2. Worker code punya fallback default ke Sheet ID yang sudah Anda berikan.

Secret service account tetap **tidak boleh** dimasukkan ke GitHub.

---

## Struktur repo

```text
public/
  index.html              # UI frontend Cloudflare Pages
  _headers                # security headers

functions/
  api/
    check.js              # POST /api/check
    health.js             # GET /api/health
    index.js              # GET /api
  _lib/
    duplicate.js          # Google Sheet + duplicate engine

scripts/
  sync_gsheet_indexed.py  # PostgreSQL MDG -> Protected Google Sheet indexed database
  requirements.txt

bats/
  install_sync_python.bat
  sync_to_gsheet_now.bat
  setup_windows_scheduler_0900_1500.bat
  remove_windows_scheduler.bat

tools/
  service_account_to_cloudflare_secret.py

wrangler.toml             # Cloudflare Pages config + non-secret env vars
.env.example              # local sync env template
.gitignore
```

---

## 1. Push folder ini ke GitHub Anda

Buat repository private di GitHub, misalnya:

```text
mdg-bp-duplicate-checker
```

Lalu upload semua file/folder di paket ini ke root repo.

Pastikan root repo langsung berisi:

```text
public
functions
scripts
bats
wrangler.toml
README_GITHUB_IMPORT.md
```

Jangan commit file ini:

```text
.env
service_account.json
```

---

## 2. Import GitHub repo ke Cloudflare Pages

Cloudflare Dashboard:

```text
Workers & Pages
→ Create application
→ Pages
→ Connect to Git
→ pilih GitHub repo Anda
```

Build settings:

| Setting | Value |
|---|---|
| Framework preset | `None` |
| Build command | kosongkan |
| Build output directory | `public` |
| Root directory | `/` |

Deploy.

---

## 3. Tambahkan Cloudflare variables/secrets

Masuk ke project Pages:

```text
Workers & Pages
→ project Anda
→ Settings
→ Variables and Secrets
```

Tambahkan untuk **Production**. Kalau Anda test dari Preview deployment, tambahkan juga di **Preview**.

### Variable non-secret

Sebagian sudah ada di `wrangler.toml`, tetapi boleh juga ditambahkan manual di dashboard supaya pasti.

| Name | Type | Value |
|---|---|---|
| `SHEET_ID` | Variable | `1VepIImbAMSMaDvRo6Vos9nRzxjiVWUYcestTizNJSjo` |
| `SIMILARITY_THRESHOLD` | Variable | `92` |
| `MAX_CANDIDATES` | Variable | `60000` |
| `MAX_BATCH_ROWS` | Variable | `10000` |
| `RANGE_CACHE_SECONDS` | Variable | `300` |
| `RATE_LIMIT_PER_MIN` | Variable | `60` |

### Secret wajib

Gunakan format base64 agar private key service account tidak rusak karena newline.

Di laptop/server Windows, taruh `service_account.json` di root project lokal, lalu jalankan:

```bat
python tools\service_account_to_cloudflare_secret.py
```

Copy output panjang base64-nya, lalu buat secret:

| Name | Type | Value |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON_B64` | Secret / Encrypt | hasil base64 dari script |

### Secret opsional untuk access code web

| Name | Type | Value |
|---|---|---|
| `API_ACCESS_CODE` | Secret / Encrypt | contoh `MDG-2026-SECURE` |

Kalau `API_ACCESS_CODE` diisi, user harus input access code di UI.
Kalau dikosongkan, UI bisa dipakai tanpa access code.

Setelah menambah variable/secret, lakukan **Retry deployment** atau push commit kecil agar Pages redeploy.

---

## 4. Share Google Sheet ke service account

Buka `service_account.json`, cari:

```json
"client_email": "..."
```

Share Google Sheet ini ke email tersebut sebagai Editor:

```text
https://docs.google.com/spreadsheets/d/1VepIImbAMSMaDvRo6Vos9nRzxjiVWUYcestTizNJSjo/edit
```

Jangan publish Sheet ke web.
Jangan share ke user umum.
Proteksi tab database/index.

---

## 5. Jalankan sync database ke Google Sheet

Di Windows internal/server yang bisa akses PostgreSQL:

1. Copy `.env.example` menjadi `.env`.
2. Isi credential DB dan Sheet ID.
3. Taruh `service_account.json` di root folder lokal.
4. Jalankan:

```bat
bats\install_sync_python.bat
bats\sync_to_gsheet_now.bat
```

Jika sukses, Google Sheet akan punya tab:

```text
BP_DATABASE
KTP_INDEX
INDEX_LEN
INDEX_KTP_SHARD
META
```

Aktifkan scheduler 09:00 dan 15:00:

```bat
bats\setup_windows_scheduler_0900_1500.bat
```

---

## 6. Test Cloudflare API

Buka:

```text
https://PROJECT.pages.dev/api/health
```

Expected kalau benar:

```json
{
  "ok": true,
  "service": "MDG BP Duplicate Checker API",
  "config": {
    "sheet_id_configured": true,
    "service_account_configured": true
  },
  "sheet_ok": true,
  "meta": {
    "last_sync_at": "..."
  }
}
```

Kalau `service_account_configured=false`, berarti secret belum masuk atau belum redeploy.
Kalau `sheet_ok=false`, cek Google Sheet sharing ke service account dan pastikan tab hasil sync sudah ada.

---

## 7. Cara kerja duplicate check

User input:

- Name 1
- Address
- KTP Number

Rule gagal:

1. `KTP Number` exact match dengan `ktp_number` di protected Google Sheet.
2. `Name 1 + Address` dihitung similarity terhadap database indexed dengan:
   - Levenshtein Similarity
   - Jaccard Similarity
   - Numeric Weighted Similarity

Optimasi:

- Tidak scan seluruh 1 juta row langsung.
- Lookup KTP memakai shard index `INDEX_KTP_SHARD`.
- Similarity hanya ke bucket panjang text ±5 via `INDEX_LEN`.
- Fetch batch default 10.000 row.
- Stop ketika match di atas threshold ditemukan.
- Range Google Sheets dicache sementara di edge runtime.

---

## 8. Security production recommended

Karena data sensitif:

1. Repository GitHub gunakan Private.
2. Jangan commit `.env` dan `service_account.json`.
3. Google Sheet jangan dipublish.
4. Share Sheet hanya ke service account dan admin.
5. Aktifkan `API_ACCESS_CODE`.
6. Idealnya tambahkan Cloudflare Access / Zero Trust untuk restrict domain/email internal.

---

## 9. Troubleshooting cepat

### `SHEET_ID is not configured`

Versi ini seharusnya tidak kena error ini karena ada fallback. Jika masih muncul:

- Pastikan Cloudflare import dari root repo yang benar.
- Pastikan file `functions/_lib/duplicate.js` adalah versi baru.
- Set manual variable `SHEET_ID` di Pages Settings.
- Redeploy.

### `Google service account secret is not configured`

- Tambahkan secret `GOOGLE_SERVICE_ACCOUNT_JSON_B64`.
- Pastikan secret ditambahkan ke Production environment.
- Redeploy.

### `Google Sheets API error 403`

- Google Sheet belum dishare ke service account `client_email`.
- Service account salah project/file.
- Sheet protected tetapi service account bukan editor.

### `Unable to parse range`

- Sync belum membuat tab `BP_DATABASE`, `KTP_INDEX`, `INDEX_LEN`, `INDEX_KTP_SHARD`, `META`.
- Nama tab berubah.

### `Google Sheets API error 400/429`

- Terlalu banyak request atau range terlalu besar.
- Naikkan cache `RANGE_CACHE_SECONDS`.
- Turunkan `MAX_CANDIDATES`.
- Pastikan `INDEX_LEN` dibuat dengan benar.

---

## 10. Query default sync

Default query di `scripts/sync_gsheet_indexed.py`:

```sql
SELECT
    bgv.bp_id::text AS bp_id,
    bgv.bp_type_id::text AS bp_type_id,
    COALESCE(bgv.name_1, '')::text AS name_1,
    COALESCE(bgv.address, '')::text AS address,
    COALESCE(mbdc.ktp_number, '')::text AS ktp_number
FROM m_bp_general_view bgv
LEFT JOIN m_bp_doc_completion mbdc
       ON mbdc.bp_id = bgv.bp_id
WHERE bgv.bp_id IS NOT NULL;
```

Kalau actual address bukan `bgv.address`, override via `.env` `DB_QUERY` atau edit script.
