// This loads the library globally into the service worker safely
importScripts('openpgp.min.js');

let sessionPrivateKey = null; // Stays in memory, never written to disk

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.action === 'getMyPublicKey') {
        // --- NEW: Require session to be unlocked ---
        if (!sessionPrivateKey) {
            return sendResponse({ error: "SESSION_LOCKED" });
        }
        
        chrome.storage.local.get('myPublicKey', (data) => {
            if (data.myPublicKey) {
                sendResponse({ success: true, publicKey: data.myPublicKey });
            } else {
                sendResponse({ success: false, error: "No public key found. Please generate keys in the extension popup first." });
            }
        });
        return true;
    }

    // --- NEW: Handle privileged native downloads ---
    if (request.action === 'downloadFile') {
        chrome.downloads.download({
            url: request.dataUrl,
            filename: request.name,
            saveAs: true // Forces the browser to show the "Save As" window prompt
        });
        sendResponse({ success: true });
        return true;
    }

    // --- NEW: Sign Cleartext Message ---
    if (request.action === 'signMessage') {
        (async () => {
            if (!sessionPrivateKey) {
                return sendResponse({ error: "SESSION_LOCKED" });
            }
            try {
                // Creates an unencrypted OpenPGP cleartext message object
                const cleartextMessage = await openpgp.createCleartextMessage({ text: request.text });
                
                // Signs it using your private key
                const signedData = await openpgp.sign({
                    message: cleartextMessage,
                    signingKeys: sessionPrivateKey
                });

                sendResponse({ success: true, signedData: signedData });
            } catch (error) {
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

    // --- NEW: Verify Cleartext Signature ---
    if (request.action === 'verifySignature') {
        (async () => {
            try {
                const senderEmail = request.senderEmail.toLowerCase().trim();
                const storageKey = `pubKey_${senderEmail}`;
                const data = await chrome.storage.local.get(storageKey);
                const senderPubKeyArmored = data[storageKey];

                // If we don't have their public key, we can't verify the signature
                if (!senderPubKeyArmored) {
                    return sendResponse({ error: "MISSING_KEY" });
                }

                const publicKey = await openpgp.readKey({ armoredKey: senderPubKeyArmored });
                const signedMessage = await openpgp.readCleartextMessage({ armoredText: request.signedData });
                
                const verificationResult = await openpgp.verify({
                    message: signedMessage,
                    verificationKeys: publicKey
                });

                // Check the validity of the first signature profile
                try {
                    await verificationResult.signatures[0].verified;
                    sendResponse({ success: true, plaintext: signedMessage.getText(), status: 'verified' });
                } catch (e) {
                    sendResponse({ success: true, plaintext: signedMessage.getText(), status: 'invalid' });
                }
            } catch (error) {
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

// --- UPDATED: Decrypt Payload and Extract Attachments ---
    if (request.action === 'decryptMessage') {
        (async () => {
            if (!sessionPrivateKey) {
                return sendResponse({ error: "SESSION_LOCKED" });
            }
            try {
                const message = await openpgp.readMessage({ armoredMessage: request.encryptedData });
                
                let verificationKeys = [];
                
                // 1. FAST PATH: Use the extracted email address
                const senderEmail = request.senderEmail.toLowerCase().trim();
                const storageKey = `pubKey_${senderEmail}`;
                const data = await chrome.storage.local.get(storageKey);
                
                if (data[storageKey]) {
                    const key = await openpgp.readKey({ armoredKey: data[storageKey] });
                    verificationKeys.push(key);
                }

                // 2. BULLETPROOF PATH: Load all saved public keys if specific one wasn't found
                // OpenPGP will automatically match the correct one using the signature's Key ID.
                if (verificationKeys.length === 0) {
                    const allData = await chrome.storage.local.get(null);
                    for (const k in allData) {
                        if (k.startsWith('pubKey_')) {
                            try {
                                const key = await openpgp.readKey({ armoredKey: allData[k] });
                                verificationKeys.push(key);
                            } catch(e) {} // Ignore badly formatted stored keys
                        }
                    }
                }

                const decryptionOptions = {
                    message,
                    decryptionKeys: sessionPrivateKey
                };
                
                if (verificationKeys.length > 0) {
                    decryptionOptions.verificationKeys = verificationKeys;
                }

                const { data: decrypted, signatures } = await openpgp.decrypt(decryptionOptions);
                
                let signatureStatus = 'unverified';
                if (signatures && signatures.length > 0) {
                    if (verificationKeys.length === 0) {
                        signatureStatus = 'missing_key';
                    } else {
                        try {
                            await signatures[0].verified;
                            signatureStatus = 'verified';
                        } catch (e) {
                            if (e.message && e.message.toLowerCase().includes('hash')) {
                                signatureStatus = 'invalid';
                            } else {
                                signatureStatus = 'missing_key';
                            }
                        }
                    }
                } else if (verificationKeys.length === 0) {
                    signatureStatus = 'missing_key';
                }

                // --- UPDATED PARSING LOGIC IN BACKGROUND.JS ---
                let payload = {};
                try {
                    // Try to parse our multi-part encrypted JSON structural payload
                    payload = JSON.parse(decrypted);
                } catch (e) {
                    // Fallback: If it's not JSON, treat the whole block as legacy plain-text
                    payload = { message: decrypted, attachments: [] };
                }

                sendResponse({ 
                    success: true, 
                    plaintext: payload.message || '',
                    attachments: payload.attachments || [], 
                    signatureStatus: signatureStatus
                });
            } catch (error) {
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }


    
    if (request.action === 'generateKeys') {
        (async () => {
            try {
                const { privateKey, publicKey } = await openpgp.generateKey({
                    type: 'ecc',
                    curve: 'curve25519',
                    userIDs: [{ name: request.name, email: request.email }],
                    passphrase: request.passphrase
                });

                await chrome.storage.local.set({
                    myPublicKey: publicKey,
                    myEncryptedPrivateKey: privateKey 
                });
                sendResponse({ success: true });
            } catch (error) {
                console.error(error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true; // Keep message channel open for async response
    }

    if (request.action === 'unlockSession') {
        (async () => {
            try {
                const data = await chrome.storage.local.get('myEncryptedPrivateKey');
                if (!data.myEncryptedPrivateKey) throw new Error("No keys found.");

                const privateKey = await openpgp.readPrivateKey({ armoredKey: data.myEncryptedPrivateKey });
                sessionPrivateKey = await openpgp.decryptKey({
                    privateKey,
                    passphrase: request.passphrase
                });
                sendResponse({ success: true });
            } catch (error) {
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

// Inside your chrome.runtime.onMessage.addListener block for 'encryptMessage':
if (request.action === 'encryptMessage') {
    (async () => {
        try {
            // 1. CRITICAL CORRECTION: Return the standard flag expected by content.js
            if (!sessionPrivateKey) {
                return sendResponse({ error: "SESSION_LOCKED" });
            }

            const recipientEmail = request.recipientEmail;
            const storageKey = `pubKey_${recipientEmail}`;
            const data = await chrome.storage.local.get(storageKey);
            const recipientPubKeyArmored = data[storageKey];

            if (!recipientPubKeyArmored) {
                return sendResponse({ error: `Missing public key for ${recipientEmail}. Ask them to share their key first!` });
            }

            const unifiedPayload = JSON.stringify({
                message: request.text,
                attachments: request.attachments || []
            });

            const publicKey = await openpgp.readKey({ armoredKey: recipientPubKeyArmored });
            const message = await openpgp.createMessage({ text: unifiedPayload });

            const encrypted = await openpgp.encrypt({
                message: message,
                encryptionKeys: publicKey,
                signingKeys: sessionPrivateKey 
            });

            // Fetch your public key from local storage
            const myKeyData = await chrome.storage.local.get('myPublicKey');
            const myPubKey = myKeyData.myPublicKey ? `\n\n${myKeyData.myPublicKey}` : "";

            // Send the encrypted message with your public key attached at the bottom
            sendResponse({ success: true, encryptedData: encrypted + myPubKey });
        } catch (error) {
            sendResponse({ success: false, error: error.message });
        }
    })();
    return true;
}

    if (request.action === 'savePublicKey') {
        // Save discovered key by email address
        const keyData = {};
        keyData[`pubKey_${request.email}`] = request.keyBlock;
        chrome.storage.local.set(keyData);
        sendResponse({ success: true });
    }
});