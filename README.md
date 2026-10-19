# Probe Tracker

Offline app (PWA) for tracking AFM probes in boxes. Works on Android and in a desktop browser.
All data stays on the device (browser storage). Nothing is uploaded.

## Put it online (GitHub Pages, one-time)

1. On GitHub: **New repository** → name `probe-tracker` → Public → Create.
2. **Add file → Upload files** → drag in *all files and folders from this zip* (index.html must be at the top level) → Commit.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder `/ (root)` → Save.
4. After ~1 minute the app is at `https://<your-username>.github.io/probe-tracker/`.

The repository only holds the app code. Your probe data never goes to GitHub.

## Install on the phone

Open the URL in **Chrome** → menu ⋮ → **Install app** (or *Add to home screen*).
After the first start it works fully offline. Installing also makes Android keep the data
(Settings → Storage shows "protected storage: yes").

## Moving data between PC and phone

Each device has its own data. To move it: Settings → **Save backup file** (or *Share backup*)
on one device → Settings → **Restore from backup** on the other. The backup includes photos.
Restoring replaces everything on the target device.

## Spreadsheet import/export

- One row per probe, with a `Box` column. Boxes are created automatically on import.
- **Merge** updates probes with the same Box + ID and adds new ones; **Replace all** wipes first.
- CSV export uses `;` and decimal comma (Czech Excel). CSV import accepts both `;` and `,`, UTF-8 or windows-1250.
- Resistances can be typed as `2G`, `1.07M`, `500k` or `2E9`.
- Settings → *Download empty template* has a Help sheet listing types, statuses and fields.

## Updating the app

Change the files, **bump `VERSION` in `sw.js`**, and upload again. Phones pick up the new version
on the next start (a "Reload" toast appears).

Probe types and their fields are defined at the top of `app.js` (`TYPES`, `FIELDS`).
