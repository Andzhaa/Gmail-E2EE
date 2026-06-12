# Gmail-E2EE
Extension for KFDatasec2026 course, Gemini AI used to assist in coding.
An End-to-End Encryption (E2EE) solution for Gmail using OpenPGP.js and Chrome Manifest V3.

## Key Features
- **Native Gmail Integration**: Custom UI buttons injected directly into the Gmail compose window.
- **Automated Handshake**: One-click key requests and automated key-back replies.
- **Secure Key Management**: Private keys are encrypted with a passphrase and stored in memory only during active sessions.
- **Global Lookup**: Integration with `keys.openpgp.org` for seamless recipient discovery.

## Installation & Activation
1. Download or clone this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **"Developer mode"** (top right toggle).
4. Click **"Load unpacked"** and select the folder containing the extension files.
5. Navigate to Gmail. You will see a "Secure Setup" modal if it's your first time.

## Security Note
This extension is a proof-of-concept. Private keys are stored in `chrome.storage.local` encrypted with your passphrase. Ensure you use a strong, unique passphrase.
