Lock any file or folder behind a password on Windows and macOS, and prove later that its contents did not change. The [user manual](https://github.com/bhskr44/password-protect/blob/main/docs/MANUAL.md) explains every step.

## Get started

**Windows 10 or 11:** download `PasswordProtect-*-win-x64.exe` and double-click it to install. If SmartScreen appears, choose **More info**, then **Run anyway**.

**Mac with Apple silicon:** open `PasswordProtect-*-mac-arm64.dmg` and drag the app to Applications. Open it once, then go to **System Settings > Privacy & Security** and choose **Open Anyway**.

Neither app is signed with a paid developer certificate, which is why those warnings appear.

## New in this version

- A full desktop app with a window on both Windows and Mac. No terminal needed.
- Drag and drop files and folders, and double-click `.locked` files to open them.
- A seal drawn from each SHA-256, so two copies can be compared at a glance.
- History and Check screens, plus a Help tab with the manual.

Files locked with earlier versions still unlock.

## What it does

- Encrypts files and folders into a single `.locked` file with AES-256
- Records who locked and unlocked what, when, with a SHA-256 of the contents
- Verifies a locked file with its password, without unlocking it
- Compares SHA-256 values between machines to show nothing changed
- Unlocks and extracts `.zip` files in one step

The `protect` files are the command-line program for scripts. Most people do not need them.

**A forgotten password cannot be recovered.**
