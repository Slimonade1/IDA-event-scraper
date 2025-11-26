# IDA Watcher – Opsætningsguide

Denne guide beskriver alle trin for at få IDA Watcher-programmet til at køre som en Windows-service.

Programmet kører passivt som en baggrundsproces ved startup, og vil underrette dig via e-mail notifikation. Projektet har taget udgangspunkt i Gmail, men det er også muligt at bruger andre e-mail services.

---

## 1. Dependencies
Programmet kræver:
- **Node.js v18+** (fordi vi bruger global `fetch`)
- **npm-pakker**:
  ```bash
  npm init -y
  npm install dotenv nodemailer
  ```

---

## 2. Hent IDA_AUTH SiteKey
For at hente events fra IDA via Cludo API skal du bruge en **SiteKey**.

Sådan finder du den:
1. Gå til [https://ida.dk](https://ida.dk) og åbn udviklerværktøjer (F12).
2. Gå til fanen **Network** og søg efter kald til `cludo.com`.
3. Find en POST-request til `https://api.cludo.com/api/v3/.../search`.
4. Under **Headers** → **Authorization** ser du noget som:
   ```
   SiteKey <din nøgle>
   ```
5. Kopiér hele værdien og indsæt i `.env` som:
   ```dotenv
   IDA_AUTH=SiteKey <din nøgle>
   ```

---

## 3. Opret Gmail App Password
For at sende e-mails via Gmail skal du bruge et **App Password** (kræver 2FA).

Sådan gør du:
1. Log ind på din Google-konto.
2. Gå til [https://myaccount.google.com/security](https://myaccount.google.com/security).
3. Aktivér **2-trinsbekræftelse** (hvis ikke allerede aktiv).
4. Under **App passwords** → Opret et nyt.
5. Vælg "Mail" som app og "Windows computer" som enhed.
6. Kopiér den 16-cifrede kode og brug den som `SMTP_PASS` i `.env`.

Eksempel på `.env`:
```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=din@gmail.com
!! SMTP_PASS=<dit_app_password> !! CHANGE THIS
MAIL_FROM=din@gmail.com
MAIL_TO=modtager@domæne.dk
```

---

## 4. Installer NSSM (Non-Sucking Service Manager)
NSSM gør det muligt at køre Node.js-scriptet som en Windows-service.

Sådan gør du:
1. Download NSSM fra [https://nssm.cc/download](https://nssm.cc/download).
2. Pak ud til fx `C:\nssm`.
3. Flyt "nssm.exe" til "DIRECTORY TO YOUR FOLDER"
4. Åbn **CMD som administrator**.
5. Installer servicen:
   ```cmd
   nssm install IDAWatcher "C:\Program Files\nodejs\node.exe" ida-watch-email.mjs
   ```
6. Sæt startup directory og logfiler:
   ```cmd
   nssm set IDAWatcher AppDirectory "DIRECTORY TO YOUR FOLDER"
   nssm set IDAWatcher AppStdout "DIRECTORY TO YOUR FOLDER\ida-watcher.log"
   nssm set IDAWatcher AppStderr "DIRECTORY TO YOUR FOLDER\ida-watcher-error.log"
   ```
7. Start servicen:
   ```cmd
   nssm start IDAWatcher
   ```

---

## 5. Filstruktur
Din mappe skal indeholde:
```
IdaWatcher/
│
├─ ida-watch-email.mjs      # Selve scriptet
├─ .env                     # Miljøvariabler
├─ seen.json                # Oprettes automatisk
└─ ida-watcher.log          # Logfil (valgfri)
```

---

## 6. Test
- Bekræft alt virker
  ```cmd
  node ida-watch-email.mjs --send -now
  ```
- Tjek status:
  ```cmd
  sc query IDAWatcher
  ```
- Stop/start:
  ```cmd
  nssm stop IDAWatcher
  nssm start IDAWatcher
  ```
- Fjern service:
  ```cmd
  nssm remove IDAWatcher confirm
  ```

Nu kører din IDA Watcher som en Windows-service og starter automatisk ved boot.
