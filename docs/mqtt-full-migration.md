# Migrasi komunikasi VOLTIX V.01 ke MQTT

## Status arsitektur

Firebase Realtime Database tidak lagi digunakan oleh firmware atau dashboard
untuk live data, command, settings, maupun history. Firebase Authentication
tetap dipakai hanya untuk login user dan verifikasi ID token pada API.

Alur runtime sekarang:

```text
ESP32 -- MQTT TLS 8883 --> HiveMQ Cloud <-- WSS 8884 -- Web (read-only live)
                              |
                              +-- MQTT worker --> PostgreSQL
                                      ^               ^
                                      |               |
Web -- Firebase ID token --> API -----+---------------+
```

MQTT hanya transport. PostgreSQL menyimpan snapshot live, settings, ACK
command, event, serta history permanen. Semua sesi selesai tetap ditulis ke
LittleFS terlebih dahulu. File baru ditandai tersinkron setelah worker berhasil
menyimpan sesi ke PostgreSQL dan mengirim `history/ack`.

## Topic aktif untuk device01

| Topic | Arah | QoS | Retain |
| --- | --- | ---: | --- |
| `voltix/device01/status` | ESP -> cloud | 1 | ya |
| `voltix/device01/telemetry` | ESP -> cloud | 0 | tidak |
| `voltix/device01/session` | ESP -> cloud | 1 | tidak |
| `voltix/device01/event` | ESP -> cloud | 1 | tidak |
| `voltix/device01/history` | ESP -> worker | 1 | tidak |
| `voltix/device01/history/ack` | worker -> ESP | 1 | tidak |
| `voltix/device01/history/cleanup` | worker -> ESP | 1 | ya, sampai ACK |
| `voltix/device01/history/cleanup/ack` | ESP -> worker | 1 | tidak |
| `voltix/device01/command` | API -> ESP | 1 | tidak |
| `voltix/device01/command/ack` | ESP -> web/worker | 1 | tidak |
| `voltix/device01/config` | API -> ESP | 1 | ya |
| `voltix/device01/config/state` | ESP -> worker | 1 | tidak |

Last Will pada topic status adalah `{"online":false}` dan retained. Setelah
connect/reconnect, ESP memublikasikan status online terbaru.

## Credential HiveMQ dan ACL

Buat tiga credential berbeda. Jangan memakai ulang password ESP untuk web atau
backend.

1. Credential ESP di `firmware/include/credentials.h`:
   - publish: `status`, `telemetry`, `session`, `event`, `history`,
     `command/ack`, `config/state`, `history/cleanup/ack`;
   - subscribe: `command`, `config`, `history/ack`, `history/cleanup`.
2. Credential service backend:
   - subscribe: semua output ESP di atas;
   - publish: `command`, `config`, `history/ack`, `history/cleanup`.
3. Credential browser read-only:
   - subscribe saja: `status`, `telemetry`, `session`, `event`, `command/ack`;
   - tidak memiliki izin publish.

Semua ACL dibatasi ke prefix `voltix/device01/`. Root CA harus tetap diisi dan
validasi sertifikat TLS tidak boleh dinonaktifkan.

## Environment backend dan web

Salin nama variabel dari `.env.example`. Nilai minimum production:

```dotenv
DATABASE_URL=postgresql://...
DATABASE_SSL=true

FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

MQTT_SERVICE_USERNAME=...
MQTT_SERVICE_PASSWORD=...
MQTT_WORKER_CLIENT_ID=voltix-backend-worker

MQTT_WEB_USERNAME=...
MQTT_WEB_PASSWORD=...
```

Variabel Firebase Web App (`FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, dan
lainnya) tetap diperlukan saat build web karena login masih memakai Firebase
Authentication. `FIREBASE_DATABASE_URL` hanya dibutuhkan oleh endpoint token
broker lama yang kini terisolasi dan tidak dipakai firmware MQTT.

## Urutan deployment

1. Buat PostgreSQL dan pastikan koneksi TLS dapat digunakan dari hosting.
2. Deploy worker yang selalu hidup. Vercel Functions tidak cocok untuk koneksi
   subscribe MQTT jangka panjang. Gunakan container/VPS/worker service seperti
   Render, Railway, Fly.io, atau layanan sejenis.
3. Untuk container worker, build dari root repo:

   ```sh
   docker build -f Dockerfile.mqtt-worker -t voltix-mqtt-worker .
   docker run --env-file .env voltix-mqtt-worker
   ```

   Saat mulai, worker menjalankan `backend/schema.sql` secara idempotent.
4. Pasang environment API di Vercel lalu deploy web/API.
5. Pastikan worker menampilkan `[mqtt-worker] Connected and subscribed`.
6. Baru upload firmware MQTT ke ESP32.

Jangan upload firmware hasil migrasi sebelum worker, database, dan API aktif.
Monitoring lokal tetap berjalan jika MQTT/backend mati, tetapi command web dan
sinkronisasi history cloud memang memerlukan komponen tersebut.

## Pengujian manual

1. Jalankan `npm.cmd run test:mqtt` dan `npm.cmd run build:web`.
2. Jalankan worker dengan `npm.cmd run worker:mqtt`.
3. Boot ESP dan cari log:
   - `[mqtt] Connected to HiveMQ Cloud`
   - `[mqtt-config] ...`
   - tidak ada polling Firebase/RTDB dari firmware.
4. Login web, buka dashboard, lalu pastikan status dan telemetry berubah.
5. Tekan START. API menerbitkan command dengan ID dan expiry 15 detik. ESP
   memprosesnya di loop utama, menjalankan validasi beban yang sudah ada, lalu
   mengirim ACK sesuai hasil validasi.
6. Hentikan sesi. Pastikan urutannya terlihat sebagai LittleFS save, publish
   history, worker menyimpan PostgreSQL, kemudian `history/ack` menandai file
   lokal sudah tersinkron.
7. Putuskan MQTT saat monitoring. PZEM, relay, overload protection, state sesi,
   recovery, dan penyimpanan LittleFS harus tetap berjalan lokal.

## File Firebase lama

File implementasi Firebase firmware tidak dihapus agar rollback/audit tetap
mudah, tetapi dikecualikan dari build melalui `build_src_filter` di
`firmware/platformio.ini`. Mengubah Firebase Database Rules tidak lagi
memengaruhi firmware MQTT. Dokumentasi Firebase lama adalah referensi legacy,
bukan langkah deployment V.01.
