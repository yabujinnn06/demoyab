# Yabujin Scrap Controller

Bu klasör, mevcut projelerden bağımsız kurulan Rainwater odaklı canlı arama operasyon sistemidir.

## Konum

`C:\Users\canor\OneDrive\Masaüstü\antigravity akademi\rainwater-akademi\arama-takip-portali`

## Özellikler

- admin ve operatör oturumu
- `.xlsx` içe aktarma
- kayıtları operatörlere dağıtma
- canlı durum, sonuç ve not güncelleme
- CSV dışa aktarma
- ekip ve liste yönetimi popup pencereleri
- filtreli kayıt görünümü ve sayfalama

## Lokal Çalıştırma

```powershell
cd arama-takip-portali
..\.venv\Scripts\python.exe -m uvicorn backend.app:app --reload --port 8012
```

Tarayıcı:

`http://127.0.0.1:8012`

## Render Deploy

Bu proje `render.yaml` ile blueprint olarak deploy edilebilir.

Hazır ayarlar:

- servis adı: `yabujindemo`
- hedef adres: `https://yabujindemo.onrender.com`
- health check: `/health`
- uptime monitor: `/ping`
- kalıcı disk: `/var/data`
- SQLite dosyası: `/var/data/portal.db`

## GitHub -> Render Akışı

1. Bu klasörü GitHub reposuna push et.
2. Render içinde `New +` -> `Blueprint` seç.
3. GitHub reposunu bağla.
4. Render kökteki `render.yaml` dosyasını okuyup servisi oluştursun.
5. İlk deploy tamamlanınca `https://yabujindemo.onrender.com` üzerinden aç.

## Zorunlu Env Değişkenleri

- `CALL_PORTAL_SECRET_KEY`
- `CALL_PORTAL_ADMIN_EMAIL`
- `CALL_PORTAL_ADMIN_PASSWORD`
- `CALL_PORTAL_ADMIN_NAME`
- `CALL_PORTAL_ALLOWED_ORIGINS`
- `CALL_PORTAL_DB_PATH`
- `CALL_PORTAL_TOKEN_HOURS`

Önerilen değerler:

- `CALL_PORTAL_ALLOWED_ORIGINS=https://yabujindemo.onrender.com`
- `CALL_PORTAL_DB_PATH=/var/data/portal.db`
- `CALL_PORTAL_TOKEN_HOURS=12`

## Üretim Notları

- `CALL_PORTAL_ADMIN_PASSWORD` varsayılan değerde bırakılamaz; Render başlangıçta bunu reddeder.
- `CALL_PORTAL_SECRET_KEY` varsayılan değerde bırakılamaz; Render başlangıçta bunu reddeder.
- Bu sistem SQLite kullandığı için Render tarafında tek instance ile çalıştırılmalıdır.
- Veri kalıcılığı için Render disk ayarı zorunludur; SQLite dosyası disk üzerinde tutulur.
- Uygulama başlangıcında şema migrasyonları otomatik uygulanır.

## Güvenlik Notları

- token `sessionStorage` içinde tutulur
- açık CORS kapalıdır
- giriş denemeleri veritabanı tabanlı olarak sınırlandırılır
- güvenlik başlıkları aktiftir: `CSP`, `X-Frame-Options`, `nosniff`, `no-store`
- dış font bağımlılıkları kaldırılmıştır
- operatör CSV dışa aktarımında yalnızca kendi atanmış kayıtlarını alabilir

## Teknik Notlar

- Excel import ham request body ile alınır
- `.xlsx` çözümleme için harici `openpyxl` bağımlılığı yoktur
- giriş denemeleri `login_attempts` tablosunda izlenir
- şema sürümleri `schema_migrations` tablosunda tutulur
- lokal veritabanı dosyası `data/portal.db` altındadır
