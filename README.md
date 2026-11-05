# Password Protect

Lock any file or folder behind a password on Windows or macOS, and prove later
that its contents did not change.

- **Locking** turns a file or folder into one encrypted `.locked` file.
- **Unlocking** restores the original, including its folders and modified times.
- **Every lock and unlock is recorded** with who did it, when, and a SHA-256
  fingerprint of the contents.
- **Works across machines.** A file locked on Windows unlocks on macOS, and the
  reverse.

> **A forgotten password cannot be recovered.** There is no reset and no back
> door. Keep it in a password manager.

## Download

Get the latest version from the [Releases page](../../releases/latest).

| Your computer | Download |
| --- | --- |
| Windows 10 or 11 | `PasswordProtect-<version>-windows-x64.exe` |
| Mac with Apple silicon (M1 or later) | `PasswordProtect-<version>-macos-arm64.dmg` |

Neither download is signed with a paid developer certificate, so your computer
warns you the first time.

**Windows:** if SmartScreen appears, choose **More info**, then **Run anyway**.
There is nothing to install; the `.exe` is the whole app.

**Mac:** open the `.dmg` and drag **Password Protect** to **Applications**. Open
it once. When macOS blocks it, go to **System Settings > Privacy & Security**,
scroll down and choose **Open Anyway**.

## Lock a file or folder

**Mac:** drag it onto the app, or open the app and choose **Choose File…** or
**Choose Folder…**. Enter a password twice, then choose **Keep Original** or
**Delete Original**.

**Windows:** drag it onto `PasswordProtect.exe`, or double-click the `.exe` and
drag it into the window, then press Enter. Answer the prompts. Nothing appears
while you type a password; that is normal.

You get `<name>.locked` beside the original, plus its SHA-256. Save the SHA-256
if you may need to prove the contents later.

If you keep the original, that copy is still unprotected. Only the `.locked` file
is safe to store or send.

Passwords must be at least 8 characters. Use a long passphrase: a weak password
can be guessed however strong the encryption is.

## Unlock

**Mac:** double-click the `.locked` file, or drag it onto the app, then choose
**Unlock**. **Windows:** drag it onto the `.exe` and answer `U`.

Enter the password and the original appears beside the locked file. Existing
files are never overwritten: if something of that name is already there, move it
first. A locked `.zip` is extracted as well.

To extract an ordinary `.zip`, drag it onto the app and choose **Extract**.

## Check that nothing changed

Every item has a SHA-256 fingerprint. If even one byte differs, the fingerprint
is completely different. Unlocking checks this automatically, and reports
`Verified: identical to what was locked`.

### Compare two machines

1. On the first machine, lock the item and note the SHA-256 it shows.
2. Send the `.locked` file to the second machine.
3. On the second machine, choose **Verify** (Mac) or answer `V` (Windows), enter
   the password, and paste the SHA-256 from the first machine.
4. You see `MATCH: identical content` or `DOES NOT MATCH`.

**Verify needs the password** and writes nothing to disk, so it shows what is
inside a locked file without unlocking it. It also shows who locked it.

Send the SHA-256 by a different route from the file, such as a phone call or a
separate message. Someone who could alter the file in transit could otherwise
alter the fingerprint too.

### See who did what

**Mac:** open the app and choose **History & SHA-256…**, then **View History**.
**Windows:** double-click the `.exe` and type `history`.

Each entry shows the time, the action, the user and computer, the path, the
SHA-256 and the result:

| Result | Meaning |
| --- | --- |
| `First time recorded` | This content has not been seen on this computer |
| `Unchanged` | Same content as the last time this item was recorded |
| `CHANGED` | The content differs from the last time |
| `Verified` | Unlocked content is identical to what was locked |
| `MATCH` / `DOES NOT MATCH` | Result of comparing with another SHA-256 |

### What the history can and cannot prove

- **Each computer keeps its own history.** Nothing is sent anywhere, so to see
  both sides, compare the history on both machines. Each `.locked` file also
  carries, encrypted inside it, who locked it, when and its SHA-256, and that
  travels with the file. Whether it was unlocked elsewhere is not recorded in it.
- **"Who" means the account logged in to the computer.** It is not proof of a
  person's identity.
- **The history file is an ordinary file.** It stops honest mistakes rather than
  a determined person with access to that computer. Copy it elsewhere if it has
  to stand up as evidence.
- **It contains file names and paths in plain text,** even though they are hidden
  inside the `.locked` file. It never contains passwords.

History is stored at:

- **Mac:** `~/Library/Application Support/Password Protect/history.jsonl`
- **Windows:** `%APPDATA%\PasswordProtect\history.jsonl`

### Check a SHA-256 with other tools

For a single file, the fingerprint is its ordinary SHA-256, so standard tools give
the same answer:

```sh
shasum -a 256 report.pdf                # Mac
certutil -hashfile report.pdf SHA256    # Windows
```

A folder's fingerprint covers every item's relative path and contents, so use
`protect hash`. Moving the folder, renaming the folder itself, or changing only
timestamps or permissions does not alter it. Renaming anything inside it does.

## Command line

On Mac the program is at
`/Applications/Password Protect.app/Contents/Resources/protect`. On Windows, use
the `.exe` in place of `protect`.

```sh
protect                                  # guided mode
protect lock Reports                     # creates Reports.locked
protect lock Reports --remove            # also deletes the verified original
protect unlock Reports.locked            # restores beside the locked file
protect unlock Reports.locked -o Restored
protect unlock Reports.zip.locked --unzip
protect unzip Reports.zip
protect verify Reports.locked            # asks for the password, restores nothing
protect verify Reports.locked --against <sha256>
protect verify Reports.locked --against ./copy-of-Reports
protect hash Reports                     # needs no password
protect history                          # newest first
protect history Reports --limit 10
```

`verify` exits with status 1 if the comparison fails. Scripts can supply the
password with `--password-stdin`. It is never accepted as an argument, because
arguments are visible to other programs.

## How it protects your files

- **Encryption:** AES-256-GCM. The key comes from your password through scrypt
  (N=2^17, r=8, p=1), so each guess costs 128 MiB of memory.
- **Hidden:** contents, names of everything inside a locked folder, and who
  locked it.
- **Tamper-evident:** any edit, reordering or truncation is detected, and nothing
  is restored from a damaged file.

## Limits

- The name and size of the `.locked` file are visible. `Tax Docs` becomes
  `Tax Docs.locked`; use `-o` to give it a neutral name.
- Deleting an original is an ordinary delete, and traces can remain on an SSD.
  FileVault or BitLocker covers that.
- Finder tags, other extended attributes and ACLs are not restored. Windows has
  no permission bits, so only its read-only flag carries across.
- On Windows, names it cannot store (such as `what?.txt`) are renamed on restore,
  and symlinks are skipped unless Developer Mode is on. The app reports both.
- Zips with their own password cannot be extracted.
- Sockets, pipes and devices cannot be locked.

## Development

```sh
npm install
npm test
npm run build:mac                # the app and .dmg, for this Mac's CPU
pwsh scripts/build-windows.ps1   # on Windows: dist/PasswordProtect.exe
```

Pushing to `main` runs the tests on Windows and macOS and builds both apps.
Pushing a tag such as `v1.1.0` also publishes them as a GitHub release.

## License

[MIT](LICENSE)
