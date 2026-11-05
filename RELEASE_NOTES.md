Lock any file or folder behind a password on Windows and macOS, and prove later that its contents did not change. See the [README](README.md) for full instructions.

## Get started

**Windows 10 or 11:** download the `.exe` and double-click it, or drag a file or folder onto it. If SmartScreen appears, choose **More info**, then **Run anyway**.

**Mac with Apple silicon:** open the `.dmg` and drag the app to Applications. Open it once, then go to **System Settings > Privacy & Security** and choose **Open Anyway**.

Neither app is signed with a paid developer certificate, which is why those warnings appear.

## What it does

- Encrypts files and folders into a single `.locked` file with AES-256
- Records who locked and unlocked what, when, with a SHA-256 of the contents
- Verifies a locked file with its password, without unlocking it
- Compares SHA-256 values between machines to show nothing changed
- Unlocks and extracts `.zip` files in one step

**A forgotten password cannot be recovered.**
