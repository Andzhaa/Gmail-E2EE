document.getElementById('btn-generate').addEventListener('click', () => {
    const name = document.getElementById('gen-name').value;
    const email = document.getElementById('gen-email').value;
    const passphrase = document.getElementById('gen-passphrase').value;
    const statusEl = document.getElementById('gen-status');

    statusEl.innerText = "Generating keys... (this may take a moment)";
    
    chrome.runtime.sendMessage({ 
        action: 'generateKeys', 
        name, 
        email, 
        passphrase 
    }, (response) => {
        if (response.success) {
            statusEl.innerText = "Keys generated successfully!";
        } else {
            statusEl.innerText = "Error generating keys.";
        }
    });
});

document.getElementById('btn-unlock').addEventListener('click', () => {
    const passphrase = document.getElementById('unlock-passphrase').value;
    const statusEl = document.getElementById('unlock-status');

    chrome.runtime.sendMessage({ 
        action: 'unlockSession', 
        passphrase 
    }, (response) => {
        if (response.success) {
            statusEl.innerText = "Session Unlocked!";
            document.getElementById('unlock-passphrase').value = '';
        } else {
            statusEl.innerText = "Incorrect passphrase.";
        }
    });
});

document.addEventListener('DOMContentLoaded', () => {
    const exportBtn = document.getElementById('export-btn');
    const importBtn = document.getElementById('import-btn');
    const filePicker = document.getElementById('import-file-picker');
    const statusMsg = document.getElementById('status-message');

    // Helper to display clean contextual UI status notices
    function flashStatus(text, isError = false) {
        statusMsg.innerText = text;
        statusMsg.style.color = isError ? '#c5221f' : '#137333';
        setTimeout(() => { statusMsg.innerText = ''; }, 3500);
    }

    // --- 1. EXPORT KEYRING LOGIC ---
    exportBtn.onclick = () => {
        // Retrieve all data objects stored locally by this extension
        chrome.storage.local.get(null, (allData) => {
            const keyringExport = {};
            let count = 0;

            // Filter out everything except recipient public keys
            Object.keys(allData).forEach(key => {
                if (key.startsWith('pubKey_')) {
                    const email = key.replace('pubKey_', '');
                    keyringExport[email] = allData[key];
                    count++;
                }
            });

            if (count === 0) {
                flashStatus("Your address book is empty!", true);
                return;
            }

            // Wrap data into an organized, readable JSON file string structure
            const jsonString = JSON.stringify(keyringExport, null, 2);
            const blob = new Blob([jsonString], { type: 'application/json' });
            
            // Generate a transient Object URL pointer to avoid sandbox restrictions
            const blobUrl = URL.createObjectURL(blob);
            
            const timestamp = new Date().toISOString().slice(0, 10);
            
            // Route seamlessly through Chrome's background download framework
            chrome.downloads.download({
                url: blobUrl,
                filename: `e2ee_public_keyring_${timestamp}.json`,
                saveAs: true
            }, () => {
                flashStatus(`Successfully exported ${count} keys!`);
                URL.revokeObjectURL(blobUrl); // Instantly clean up memory allocation
            });
        });
    };

    // --- 2. IMPORT KEYRING LOGIC ---
    importBtn.onclick = () => filePicker.click(); // Proxy click into hidden file manager element

    filePicker.onchange = (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const importedData = JSON.parse(e.target.result);
                const storagePayload = {};
                let count = 0;

                // Validate and normalize entries inside the JSON mapping
                Object.keys(importedData).forEach(email => {
                    const cleanEmail = email.toLowerCase().trim();
                    const keyBlock = importedData[email];

                    // Structural validation: Ensure it resembles an armor public block string format
                    if (cleanEmail.includes('@') && typeof keyBlock === 'string' && keyBlock.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
                        storagePayload[`pubKey_${cleanEmail}`] = keyBlock;
                        count++;
                    }
                });

                if (count === 0) {
                    throw new Error("No valid PGP public key structures found in file.");
                }

                // Batch save the verified structures right back to database storage
                chrome.storage.local.set(storagePayload, () => {
                    flashStatus(`Successfully imported ${count} keys!`);
                    filePicker.value = ''; // Flush selection cache
                });

            } catch (err) {
                console.error("Keyring compilation parse sequence failed:", err);
                flashStatus("Import failed: Invalid file layout format.", true);
                filePicker.value = '';
            }
        };
        reader.readAsText(file);
    };

    // --- 3. DOWNLOAD MY KEYS LOGIC ---
    const dlPubBtn = document.getElementById('btn-dl-pub');
    const dlPrivBtn = document.getElementById('btn-dl-priv');

    // Helper function to handle the file generation and download
    function downloadKeyAsAsc(keyBlock, filename) {
        const blob = new Blob([keyBlock], { type: 'text/plain' });
        const blobUrl = URL.createObjectURL(blob);
        
        chrome.downloads.download({
            url: blobUrl,
            filename: filename,
            saveAs: true // Prompts the user where to save it
        }, () => {
            flashStatus(`Successfully downloaded ${filename}!`);
            URL.revokeObjectURL(blobUrl); // Instantly clean up memory
        });
    }

    dlPubBtn.onclick = () => {
        chrome.storage.local.get('myPublicKey', (data) => {
            if (!data.myPublicKey) {
                flashStatus("No public key found. Generate keys first!", true);
                return;
            }
            downloadKeyAsAsc(data.myPublicKey, 'my_public_key.asc');
        });
    };

    dlPrivBtn.onclick = () => {
        chrome.storage.local.get('myEncryptedPrivateKey', (data) => {
            if (!data.myEncryptedPrivateKey) {
                flashStatus("No private key found. Generate keys first!", true);
                return;
            }
            // The private key is downloaded in its encrypted state for safety
            downloadKeyAsAsc(data.myEncryptedPrivateKey, 'my_encrypted_private_key.asc');
        });
    };

    // --- 4. IMPORT PERSONAL KEY PAIR LOGIC ---
    const importPersonalBtn = document.getElementById('btn-import-personal');
    const importPersonalPicker = document.getElementById('import-personal-picker');

    importPersonalBtn.onclick = () => importPersonalPicker.click();

    importPersonalPicker.onchange = (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target.result;
            const storageUpdates = {};
            let importedPub = false;
            let importedPriv = false;

            // 1. Hunt for the Public Key block
            const pubRegex = /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]+?-----END PGP PUBLIC KEY BLOCK-----/;
            const pubMatch = content.match(pubRegex);
            if (pubMatch) {
                storageUpdates.myPublicKey = pubMatch[0];
                importedPub = true;
            }

            // 2. Hunt for the Private Key block
            const privRegex = /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]+?-----END PGP PRIVATE KEY BLOCK-----/;
            const privMatch = content.match(privRegex);
            if (privMatch) {
                storageUpdates.myEncryptedPrivateKey = privMatch[0];
                importedPriv = true;
            }

            // 3. Save to storage and notify user
            if (!importedPub && !importedPriv) {
                flashStatus("Error: No valid PGP keys found in file.", true);
            } else {
                chrome.storage.local.set(storageUpdates, () => {
                    let msg = "Imported ";
                    if (importedPub && importedPriv) msg += "Full Key Pair!";
                    else if (importedPub) msg += "Public Key!";
                    else msg += "Private Key!";
                    flashStatus(msg);
                });
            }
            
            importPersonalPicker.value = ''; // Flush selection cache
        };
        reader.readAsText(file);
    };
});