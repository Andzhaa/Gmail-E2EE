console.log("E2EE Extension: Content script initialized.");

// --- NEW SENDER EXTRACTION HELPER (ROBUST DETECTION) ---
function getSenderIdentity(bodyNode) {
    console.log("--- E2EE DEBUG: Starting Sender Extraction ---");
    let senderEmail = 'unknown';
    let senderName = '';

    // BUG IDENTIFIED: Gmail's "View entire message" uses view=lg, not view=pt!
    // We now check for view=pt, view=lg, OR the presence of the specific legacy DOM structure.
    const isExtendedView = window.location.search.includes('view=pt') || 
                           window.location.search.includes('view=lg') || 
                           !!document.querySelector('.bodycontainer table.message');
                           
    console.log("1. Is Extended View?", isExtendedView, "| URL Search:", window.location.search);

    if (isExtendedView) {
        const messageTable = document.querySelector('table.message');
        console.log("2. Found main 'table.message'?", !!messageTable);

        if (messageTable) {
            const headerCells = messageTable.querySelectorAll('td font, td div, td');
            console.log(`3. Scanning ${headerCells.length} potential header cells...`);

            for (let i = 0; i < headerCells.length; i++) {
                const cell = headerCells[i];
                const text = cell.innerText || '';
                const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                
                if (emailMatch) {
                    console.log(`4. Found email regex match:`, emailMatch[1]);
                    
                    if (text.length < 300 && !text.includes('BEGIN PGP')) {
                        senderEmail = emailMatch[1].toLowerCase();
                        const bTag = cell.querySelector('b');
                        
                        if (bTag) {
                            senderName = bTag.innerText.trim();
                        } else {
                            // Strip the email, brackets, and quotes if no <b> tag is found
                            senderName = text.replace(emailMatch[0], '').replace(/[<>"\\n]/g, '').trim();
                        }
                        console.log("   -> Extracted Sender:", senderName, `<${senderEmail}>`);
                        break; // Exit loop, we found it!
                    } else {
                        console.log("   -> ❌ Ignored this match (Length > 300 or contains PGP block).");
                    }
                }
            }
        } else {
            console.warn("❌ Extended view detected, but could not find 'table.message'.");
        }
    } else {
        // Standard Gmail View
        const senderEl = bodyNode.closest('.h7')?.querySelector('.gD');
        console.log("1. Standard View. Found .gD element?", !!senderEl);
        senderEmail = senderEl ? senderEl.getAttribute('email').toLowerCase() : 'unknown';
        senderName = senderEl ? senderEl.innerText : '';
    }

    const finalIdentity = senderName ? `${senderName} <${senderEmail}>` : senderEmail;
    console.log("--- E2EE DEBUG: Final Extracted Identity ---", finalIdentity);
    
    return { 
        email: senderEmail, 
        identity: finalIdentity 
    };
}

// --- 1. CORE MODAL UI: PASSPHRASE PROMPT ---
function showUnlockModal(onSuccessCallback) {
    if (document.getElementById('e2ee-unlock-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'e2ee-unlock-overlay';
    overlay.style.cssText = "position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.4); z-index: 9999999; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(3px); font-family: 'Google Sans', Roboto, sans-serif;";

    const modal = document.createElement('div');
    modal.style.cssText = "background: white; width: 360px; padding: 25px; border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); text-align: center; box-sizing: border-box;";
    modal.innerHTML = `
        <div style="font-size: 20px; font-weight: bold; color: #1a73e8; margin-bottom: 6px;">🔓 Unlock Secure Session</div>
        <div style="font-size: 13px; color: #5f6368; margin-bottom: 18px;">Your cryptographic session is locked. Enter your passphrase to continue.</div>
        <input type="password" id="modal-pass" placeholder="Enter Passphrase" style="width: 100%; padding: 10px; margin-bottom: 15px; border: 1px solid #dadce0; border-radius: 4px; box-sizing: border-box; font-size: 14px;">
        <button id="modal-unlock-btn" style="width: 100%; padding: 11px; background: #1a73e8; color: white; border: none; border-radius: 4px; font-weight: bold; font-size: 14px; cursor: pointer;">Unlock Workspace</button>
        <div id="modal-err-status" style="margin-top: 12px; font-size: 13px; color: #c5221f; font-weight: 500;"></div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input = modal.querySelector('#modal-pass');
    const btn = modal.querySelector('#modal-unlock-btn');
    const status = modal.querySelector('#modal-err-status');

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
    input.focus();

    btn.onclick = () => {
        const passphrase = input.value;
        if (!passphrase) return;
        status.innerText = "Verifying...";

        chrome.runtime.sendMessage({ action: 'unlockSession', passphrase }, (response) => {
            if (response && response.success) {
                overlay.remove();
                if (typeof onSuccessCallback === 'function') onSuccessCallback();
            } else {
                status.innerText = "❌ Incorrect passphrase. Try again.";
                input.value = ""; input.focus();
            }
        });
    };
}

// --- 2. COMPOSE CONTROLS INJECTION (WITH ENCRYPTED ATTACHMENT SUPPORT) ---
function injectCryptoControls() {
    const composeWindows = document.querySelectorAll('.M9, [role="dialog"], table.aoI');
    
    composeWindows.forEach(composeWindow => {
        if (composeWindow.querySelector('.e2ee-btn-container')) return; 

        const toolbar = composeWindow.querySelector('.btC') || composeWindow.querySelector('.gU.Up') || composeWindow.querySelector('div[role="toolbar"]'); 
        
        if (toolbar) {
            // Instantiate an attachment array bound natively to this specific Compose Window object
            composeWindow._encryptedAttachments = [];

            const wrapperContainer = document.createElement('div');
            wrapperContainer.className = "e2ee-btn-container";
            wrapperContainer.style.cssText = "display: flex; flex-direction: column; margin-right: 10px; margin-left: 5px; font-family: sans-serif;";

            const btnRow = document.createElement('div');
            btnRow.style.cssText = "display: inline-flex; gap: 6px; align-items: center; vertical-align: middle;";

            // Hidden file input node
            const fileInput = document.createElement('input');
            fileInput.type = "file";
            fileInput.multiple = true;
            fileInput.style.display = "none";

            // Visual container showing files currently selected for encryption
            const previewRow = document.createElement('div');
            previewRow.style.cssText = "display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; font-size: 11px;";

            const updateAttachmentPreviews = () => {
                previewRow.innerHTML = "";
                composeWindow._encryptedAttachments.forEach((file, idx) => {
                    const chip = document.createElement('div');
                    chip.style.cssText = "background: #f1f3f4; border: 1px solid #dadce0; border-radius: 12px; padding: 2px 8px; display: flex; align-items: center; gap: 6px; color: #3c4043; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
                    chip.innerHTML = `📎 <span>${escapeHtml(file.name)}</span> <b style="cursor:pointer; color:#5f6368;" data-idx="${idx}">✕</b>`;
                    
                    chip.querySelector('b').onclick = (e) => {
                        composeWindow._encryptedAttachments.splice(idx, 1);
                        updateAttachmentPreviews();
                    };
                    previewRow.appendChild(chip);
                });
            };

            fileInput.onchange = (e) => {
                const files = Array.from(e.target.files);
                files.forEach(file => {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        composeWindow._encryptedAttachments.push({
                            name: file.name,
                            dataUrl: event.target.result // Complete Base64 String format
                        });
                        updateAttachmentPreviews();
                    };
                    reader.readAsDataURL(file);
                });
                fileInput.value = ""; // flush choice cache
            };

            // BUTTON A: Encrypt & Send
            const encryptBtn = document.createElement('div');
            encryptBtn.innerText = "🔒 Encrypt & Send";
            encryptBtn.style.cssText = "cursor:pointer; padding: 6px 12px; background: #1a73e8; color: white; border-radius: 4px; font-weight: bold; font-size: 12px; white-space: nowrap;";
            
            
            const handleEncryptionFlow = () => {
                const textArea = composeWindow.querySelector('.Am.Al.editable');
                let recipientEmail = null;
                const trackingElements = composeWindow.querySelectorAll('[email], [data-hovercard-id*="mailto:"]');
                for (const el of trackingElements) {
                    let email = el.getAttribute('email') || el.getAttribute('data-hovercard-id').split('mailto:')[1];
                    if (email && email.includes('@')) { recipientEmail = email.split('?')[0].trim(); break; }
                }
                if (!recipientEmail) {
                    const inputs = composeWindow.querySelectorAll('input, textarea');
                    for (const input of inputs) {
                        const emailMatch = (input.value || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                        if (emailMatch) { recipientEmail = emailMatch[0]; break; }
                    }
                }
                if (!recipientEmail) { alert("Recipient not detected."); return; }

                chrome.runtime.sendMessage({ 
                    action: 'encryptMessage', 
                    text: textArea.innerText, 
                    recipientEmail: recipientEmail,
                    attachments: composeWindow._encryptedAttachments 
                }, (response) => {
                    if (response && response.error === "SESSION_LOCKED") {
                        showUnlockModal(() => { handleEncryptionFlow(); });
                    } else if (response && response.error) { 
                        
                        // --- INTERCEPT MISSING KEY ERROR (WITH LOCK CHECK) ---
                        if (response.error.includes("Ask them to share their key") || response.error.includes("Could not find a public key")) {
                            const wantRequest = confirm(`${response.error}\n\nWould you like to send an automated Key Request email with your public key attached instead?`);
                            
                            if (wantRequest) {
                                const sendRequestFlow = () => {
                                    chrome.runtime.sendMessage({ action: 'getMyPublicKey' }, (keyRes) => {
                                        // 1. Check if locked, show modal, then loop back!
                                        if (keyRes && keyRes.error === "SESSION_LOCKED") {
                                            showUnlockModal(() => { sendRequestFlow(); });
                                        } 
                                        // 2. Success! Drop the mandatory key in.
                                        else if (keyRes && keyRes.success) {
                                            textArea.innerText = "Hello!\n\nI would like to send you a secure, end-to-end encrypted email, but I do not have your public key yet.\n\nPlease reply to this email and attach your public key. (If you are using the Gmail E2EE Extension, just click the yellow 'Send My Key Back' button at the top of this email!)\n\nHere is my public key so you can safely encrypt your reply to me:\n\n" + keyRes.publicKey;
                                            
                                            setTimeout(() => {
                                                const gmailSendBtn = composeWindow.querySelector('.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3') || composeWindow.querySelector('div[role="button"][data-tooltip*="Send"]');
                                                if (gmailSendBtn) gmailSendBtn.click();
                                            }, 150);
                                        } else {
                                            alert(keyRes?.error || "Failed to fetch your public key.");
                                        }
                                    });
                                };
                                sendRequestFlow(); // Start the flow
                            }
                        } else {
                            alert(response.error); 
                        }

                    } else if (response && response.success) { 
                        // Normal successful encryption flow
                        textArea.innerText = response.encryptedData; 
                        composeWindow._encryptedAttachments = []; 
                        updateAttachmentPreviews();

                        setTimeout(() => {
                            const gmailSendBtn = composeWindow.querySelector('.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3') || composeWindow.querySelector('div[role="button"][data-tooltip*="Send"]');
                            if (gmailSendBtn) gmailSendBtn.click();
                            else alert("Message encrypted! Please click Gmail's native 'Send' button to finish.");
                        }, 100);
                    }
                });
            };
            encryptBtn.onclick = (e) => { e.preventDefault(); handleEncryptionFlow(); };

            // NEW BUTTON B: Secure Attachment Linker
            const attachBtn = document.createElement('div');
            attachBtn.innerText = "📎 Encrypt File";
            attachBtn.style.cssText = "cursor:pointer; padding: 6px 12px; background: #ea4335; color: white; border-radius: 4px; font-weight: bold; font-size: 12px; white-space: nowrap;";
            attachBtn.onclick = () => fileInput.click();
            
            const handleSigningFlow = () => {
                const textArea = composeWindow.querySelector('.Am.Al.editable');
                chrome.runtime.sendMessage({ action: 'signMessage', text: textArea.innerText }, (response) => {
                    if (response && response.error === "SESSION_LOCKED") {
                        showUnlockModal(() => { handleSigningFlow(); });
                    } else if (response && response.error) { alert(response.error); }
                    else if (response && response.success) { textArea.innerText = response.signedData; }
                });
            };

            // NEW BUTTON C: Request Public Key Proactively
            const requestKeyBtn = document.createElement('div');
            requestKeyBtn.innerText = "🙋‍♂️ Request Key";
            requestKeyBtn.style.cssText = "cursor:pointer; padding: 6px 12px; background: #673ab7; color: white; border-radius: 4px; font-weight: bold; font-size: 12px; white-space: nowrap;";

            requestKeyBtn.onclick = () => {
                const textArea = composeWindow.querySelector('.Am.Al.editable');
                
                if (textArea.innerText.trim().length > 0) {
                    const confirmReplace = confirm("This will replace your current draft with an automated Key Request. Continue?");
                    if (!confirmReplace) return;
                }

                const runRequestKey = () => {
                    requestKeyBtn.innerText = "⏳ Generating...";
                    
                    chrome.runtime.sendMessage({ action: 'getMyPublicKey' }, (keyRes) => {
                        // 1. Session is locked! Prompt for passphrase.
                        if (keyRes && keyRes.error === "SESSION_LOCKED") {
                            requestKeyBtn.innerText = "🙋‍♂️ Request Key"; // Reset button visually
                            showUnlockModal(() => { runRequestKey(); });
                        } 
                        // 2. Success!
                        else if (keyRes && keyRes.success) {
                            textArea.innerText = "Hello!\n\nI would like to send you a secure, end-to-end encrypted email, but I do not have your public key yet.\n\nPlease reply to this email and attach your public key. (If you are using the Gmail E2EE Extension, just click the yellow 'Send My Key Back' button at the top of this email!)\n\nHere is my public key so you can safely encrypt your reply to me:\n\n" + keyRes.publicKey;
                            
                            setTimeout(() => {
                                const gmailSendBtn = composeWindow.querySelector('.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3') || composeWindow.querySelector('div[role="button"][data-tooltip*="Send"]');
                                if (gmailSendBtn) {
                                    gmailSendBtn.click();
                                } else {
                                    requestKeyBtn.innerText = "🙋‍♂️ Request Key";
                                    alert("Draft generated! Please click Gmail's native 'Send' button to finish.");
                                }
                            }, 150);
                        } else {
                            requestKeyBtn.innerText = "🙋‍♂️ Request Key";
                            alert(keyRes?.error || "Failed to fetch your public key.");
                        }
                    });
                };
                
                runRequestKey(); // Start the flow
            };

            btnRow.appendChild(encryptBtn);
            btnRow.appendChild(attachBtn);
            btnRow.appendChild(fileInput);
            btnRow.appendChild(requestKeyBtn);
            
            wrapperContainer.appendChild(btnRow);
            wrapperContainer.appendChild(previewRow);
            toolbar.prepend(wrapperContainer);
        }
    });
}

// --- UPDATED: Safe, Non-Destructive Inbound Email Decryption ---
function scanAndDecryptMessages() {
    // FIXED SELECTOR: 'td font' catches the text no matter how many <div> wrappers Gmail injects!
    const messageBodies = document.querySelectorAll('.a3s.aiL, table.message td font, div.msg, pre'); 
    
    messageBodies.forEach(body => {
        // 1. SAFELY READ TEXT
        const isHidden = body.style.display === 'none';
        if (isHidden) body.style.setProperty('display', 'block', 'important');
        const text = body.innerText || "";
        if (isHidden) body.style.setProperty('display', 'none', 'important');

        const beginTag = "-----BEGIN PGP MESSAGE-----";
        const endTag = "-----END PGP MESSAGE-----";
        const beginIndex = text.indexOf(beginTag);
        
        if (beginIndex === -1) return; 

        // 2. DETECT GMAIL CLIPPING (Massive File Fix)
        const endIndex = text.indexOf(endTag);
        const isClipped = endIndex === -1;

        let rawCiphertext = "";
        if (isClipped) {
            rawCiphertext = text.substring(beginIndex);
        } else {
            // Pure string math instead of Regex prevents browser crashes on massive files
            rawCiphertext = text.substring(beginIndex, endIndex + endTag.length);
        }

        if (!rawCiphertext) return;

        // 3. BULLETPROOF FINGERPRINT
        const cleanTextForFp = rawCiphertext.replace(/\s+/g, '');
        const cipherFingerprint = "fp_" + cleanTextForFp.substring(0, 50) + "_" + cleanTextForFp.length;
        
        const existingContainer = body.parentNode?.querySelector('.e2ee-decrypted-container');
        
        // --- FINGERPRINT & RE-RENDER GUARD ---
        if (existingContainer) {
            if (existingContainer.dataset.fingerprint !== cipherFingerprint) {
                existingContainer.remove(); 
            } else {
                if (existingContainer.style.display === 'none') {
                    existingContainer.style.setProperty('display', 'block', 'important');
                }
                if (body.style.display !== 'none') {
                    body.style.setProperty('display', 'none', 'important');
                }
                return; 
            }
        }

        // --- HANDLE CLIPPED MESSAGES ---
        if (isClipped) {
            let clipUrl = '';
            const searchArea = body.closest('.h7') || body.parentNode || document;
            const links = searchArea.querySelectorAll('a');
            for (const a of links) {
                if (a.innerText.toLowerCase().includes('entire message') || a.href.includes('view=pt')) {
                    clipUrl = a.href;
                    break;
                }
            }

            const clippedContainer = document.createElement('div');
            clippedContainer.className = 'e2ee-decrypted-container';
            clippedContainer.dataset.fingerprint = cipherFingerprint;
            clippedContainer.style.cssText = "border: 2px dashed #ea4335; border-radius: 8px; padding: 20px; margin: 15px 0; background: #fce8e6; font-family: sans-serif; text-align: center;";
            
            let btnHtml = clipUrl 
                ? `<a href="${clipUrl}" target="_blank" style="display: inline-block; margin-top: 15px; padding: 10px 16px; background: #ea4335; color: white; text-decoration: none; font-weight: bold; border-radius: 6px;">↗️ Open Full Message to Decrypt</a>`
                : `<div style="margin-top: 15px; font-size: 13px; color: #c5221f;"><strong>Action Required:</strong> Please scroll to the bottom of this email and click Gmail's native <strong>"View entire message"</strong> link to unlock it.</div>`;

            clippedContainer.innerHTML = `
                <div style="font-size: 18px; font-weight: bold; color: #c5221f; margin-bottom: 8px;">📎 Large Encrypted File Clipped</div>
                <div style="font-size: 14px; color: #3c4043;">Gmail has hidden the rest of this email because the encrypted file data is too large to load inline. The file cannot be downloaded until the full text is loaded.</div>
                ${btnHtml}
            `;

            body.style.setProperty('display', 'none', 'important');
            body.insertAdjacentElement('afterend', clippedContainer);
            return; 
        }

        // --- DEADLOCK PREVENTION ---
        if (body.dataset.decryptionInFlight) {
            const flightStart = parseInt(body.dataset.flightStartTime || "0", 10);
            if (Date.now() - flightStart > 5000) {
                body.removeAttribute('data-decryptionInFlight');
            } else {
                return; 
            }
        }
        
        body.dataset.decryptionInFlight = "true";
        body.dataset.flightStartTime = Date.now().toString();
        
        // --- SENDER EXTRACTION ---
        const senderInfo = getSenderIdentity(body);
        const senderEmail = senderInfo.email;
        const signerIdentity = senderInfo.identity;
        
        // SANITIZE: Strip Gmail's hidden tags
        const cleanCiphertextForDecryption = rawCiphertext
            .replace(/[\u200B\u200C\u200D\uFEFF\xAD]/g, '')
            .replace(/\u00A0/g, ' '); 

        chrome.runtime.sendMessage({ 
            action: 'decryptMessage', 
            encryptedData: cleanCiphertextForDecryption, 
            senderEmail 
        }, (response) => {
            body.removeAttribute('data-decryptionInFlight');
            
            if (response && response.success) {
                let badgeColor = '#5f6368'; let badgeText = '🔒 Decrypted';
                
                if (response.signatureStatus === 'verified') { badgeColor = '#137333'; badgeText = `✍️ Signed by: ${signerIdentity}`; }
                else if (response.signatureStatus === 'invalid') { badgeColor = '#c5221f'; badgeText = '⚠ WARNING: Invalid Signature (Altered!)'; }
                else if (response.signatureStatus === 'missing_key') { badgeColor = '#b06000'; badgeText = '🔒 Decrypted (Unknown Signature - Missing Key)'; }

                // --- UPDATED PARSING LOGIC ---
                // Directly consume what background.js already parsed
                let cleanMessageText = response.plaintext || "";
                let attachmentsData = response.attachments || [];

                // Defensive fallback: Just in case response.plaintext is somehow still a stringified JSON
                try {
                    const parsedPayload = JSON.parse(cleanMessageText);
                    if (parsedPayload.message !== undefined) {
                        cleanMessageText = parsedPayload.message;
                        attachmentsData = parsedPayload.attachments || attachmentsData;
                    }
                } catch (jsonError) {
                    // Normal behavior: it's plain text, do nothing.
                }

                let attachmentsHtml = '';
                if (attachmentsData.length > 0) {
                    attachmentsHtml = `
                        <div style="margin-top: 15px; padding-top: 12px; border-top: 1px solid #dadce0;">
                            <div style="font-size: 12px; font-weight: bold; color: #5f6368; margin-bottom: 8px;">📎 Decrypted Attachments:</div>
                            <div style="display: flex; flex-wrap: wrap; gap: 8px;" class="decrypted-files-holder"></div>
                        </div>
                    `;
                }

                const secureContainer = document.createElement('div');
                secureContainer.className = 'e2ee-decrypted-container';
                secureContainer.dataset.fingerprint = cipherFingerprint; 
                secureContainer.style.cssText = "border: 2px solid #1a73e8; border-radius: 8px; padding: 15px; margin: 15px 0; background: #f8f9fa; font-family: sans-serif;";
                secureContainer.innerHTML = `
                    <div style="display: inline-block; padding: 4px 10px; border-radius: 4px; background: ${badgeColor}; color: white; font-weight: bold; font-size: 11px; margin-bottom: 12px;">${badgeText}</div>
                    <div style="font-family: inherit; white-space: pre-wrap; color: #202124; line-height: 1.5;">${escapeHtml(cleanMessageText)}</div>
                    ${attachmentsHtml}
                `;

                if (attachmentsData.length > 0) {
                    const holder = secureContainer.querySelector('.decrypted-files-holder');
                    attachmentsData.forEach(file => {
                        const chip = document.createElement('button');
                        chip.style.cssText = "background: #e8f0fe; color: #1a73e8; border: 1px solid #c2e7ff; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); margin-bottom: 4px;";
                        chip.innerText = `📥 Download ${file.name}`;
                        
                        chip.onclick = (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            chrome.runtime.sendMessage({
                                action: 'downloadFile',
                                dataUrl: file.dataUrl,
                                name: file.name
                            });
                        };
                        holder.appendChild(chip);
                    });
                }

                body.style.setProperty('display', 'none', 'important');
                body.insertAdjacentElement('afterend', secureContainer);

            } else if (response && response.error === "SESSION_LOCKED") {
                const lockNotice = document.createElement('div');
                lockNotice.className = 'e2ee-decrypted-container';
                lockNotice.dataset.fingerprint = cipherFingerprint; 
                lockNotice.style.cssText = "border: 2px dashed #b06000; padding: 16px; margin: 15px 0; background: #fff8e1; color: #b06000; border-radius: 8px; font-size: 14px; display: flex; align-items: center; justify-content: space-between; font-family: sans-serif;";
                lockNotice.innerHTML = `<div><strong>🔒 Secure Content Locked:</strong> Unlock session to read email and access files.</div><button class="inline-unlock-btn" style="background: #b06000; color: white; border: none; padding: 6px 12px; font-weight: bold; border-radius: 4px; cursor: pointer; font-size: 12px;">🔓 Unlock to View</button>`;
                
                lockNotice.querySelector('.inline-unlock-btn').onclick = (e) => { 
                    e.preventDefault(); 
                    e.stopPropagation();
                    showUnlockModal(() => { 
                        lockNotice.remove();
                        scanAndDecryptMessages(); 
                    }); 
                };
                
                body.style.setProperty('display', 'none', 'important');
                body.insertAdjacentElement('afterend', lockNotice);
            } else if (response && response.error) {
                const errorNotice = document.createElement('div');
                errorNotice.className = 'e2ee-decrypted-container';
                errorNotice.dataset.fingerprint = cipherFingerprint;
                errorNotice.style.cssText = "border: 2px dashed #c5221f; padding: 16px; margin: 15px 0; background: #fce8e6; color: #c5221f; border-radius: 8px; font-size: 14px; font-family: sans-serif;";
                errorNotice.innerHTML = `<strong>❌ Decryption Error:</strong> ${escapeHtml(response.error)}`;
                
                body.style.setProperty('display', 'none', 'important');
                body.insertAdjacentElement('afterend', errorNotice);
            }
        });
    });
}
// --- UPDATED: Safe, Non-Destructive Signature Verification ---
function scanAndVerifySignatures() {
    const messageBodies = document.querySelectorAll('.a3s.aiL, table.message td font, div.msg, pre'); 
    messageBodies.forEach(body => {
        const existingContainer = body.parentNode?.querySelector('.e2ee-verified-container');
        
        const text = body.innerText;
        const sigRegex = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]+?-----END PGP SIGNATURE-----/g;
        const match = text.match(sigRegex);
        
        if (match) {
            if (existingContainer) {
                if (body.style.display !== 'none') {
                    body.style.display = 'none';
                }
                return;
            }
            
            if (body.dataset.signatureInFlight) return;
            body.dataset.signatureInFlight = "true";

            const senderInfo = getSenderIdentity(body);
            const senderEmail = senderInfo.email;
            const signerIdentity = senderInfo.identity;

            chrome.runtime.sendMessage({ 
                action: 'verifySignature', 
                signedData: match[0], 
                senderEmail 
            }, (response) => {
                body.removeAttribute('data-signatureInFlight');
                
                if (response && response.success) {
                    let badgeColor = '#0f766e'; let badgeText = `✍️ Signed by: ${signerIdentity}`;
                    if (response.status === 'invalid') { badgeColor = '#c5221f'; badgeText = '⚠ WARNING: Signature Verification Failed!'; }

                    const verifiedContainer = document.createElement('div');
                    verifiedContainer.className = 'e2ee-verified-container';
                    verifiedContainer.style.cssText = "border: 2px solid #0f766e; border-radius: 8px; padding: 15px; margin: 15px 0; background: #f0fdfa; font-family: sans-serif;";
                    verifiedContainer.innerHTML = `
                        <div style="display: inline-block; padding: 4px 10px; border-radius: 4px; background: ${badgeColor}; color: white; font-weight: bold; font-size: 12px; margin-bottom: 12px;">${badgeText}</div>
                        <div style="font-family: inherit; white-space: pre-wrap; color: #0f766e; line-height: 1.5;">${escapeHtml(response.plaintext)}</div>
                    `;
                    
                    body.style.display = 'none';
                    body.insertAdjacentElement('afterend', verifiedContainer);
                }
            });
        }
    });
}

function scanForKeys() {
    const messageBodies = document.querySelectorAll('.a3s.aiL, table.message td font, div.msg, pre'); 
    messageBodies.forEach(body => {
        const text = body.innerText;
        const keyRegex = /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]+?-----END PGP PUBLIC KEY BLOCK-----/g;
        const match = text.match(keyRegex);
        if (match && !body.dataset.keyScraped) {
            body.dataset.keyScraped = "true";
            const senderEmail = getSenderIdentity(body).email;
            chrome.runtime.sendMessage({ action: 'savePublicKey', email: senderEmail, keyBlock: match[0] });
        }
    });
}

// --- NEW: INBOUND KEY REQUEST DETECTOR ---
function scanForKeyRequests() {
    const messageBodies = document.querySelectorAll('.a3s.aiL, table.message td font, div.msg, pre'); 
    
    messageBodies.forEach(body => {
        if (body.dataset.keyRequestScanned) return;

        const text = body.innerText || "";
        // Look for the exact phrasing generated by the sender extension
        if (text.includes("I would like to send you a secure, end-to-end encrypted email, but I do not have your public key yet.")) {
            body.dataset.keyRequestScanned = "true";
            
            // Prevent duplicate banners
            if (body.parentNode?.querySelector('.e2ee-key-request-container')) return;

            const senderInfo = getSenderIdentity(body);

            const banner = document.createElement('div');
            banner.className = 'e2ee-key-request-container';
            banner.style.cssText = "border: 2px solid #fbbc04; border-radius: 8px; padding: 15px; margin: 15px 0; background: #fef7e0; font-family: sans-serif;";
            banner.innerHTML = `
                <div style="font-size: 15px; font-weight: bold; color: #b08d00; margin-bottom: 6px;">🔑 Public Key Request Detected</div>
                <div style="font-size: 13px; color: #3c4043; margin-bottom: 12px;"><strong>${escapeHtml(senderInfo.identity)}</strong> wants to send you a secure message.</div>
                <button class="btn-send-key-back" style="background: #fbbc04; color: #202124; font-weight: bold; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">⚡ Send My Key Back Automatically</button>
            `;

            // Wire up the automation!
            banner.querySelector('.btn-send-key-back').onclick = (e) => {
                e.preventDefault();
                const btn = e.target;
                btn.innerText = "⏳ Generating Reply...";

                // 1. Aggressively hunt for the Reply button
                // First, find the closest message wrapper
                const emailContainer = body.closest('.adn') || body.closest('.h7') || body.parentNode;
                
                // Next, try multiple known Gmail selectors for the Reply button
                let replyBtn = emailContainer.querySelector('.ams.bkH') || // "Reply" text at bottom
                               emailContainer.querySelector('div[data-tooltip="Reply"]') || // Arrow icon top right
                               emailContainer.querySelector('span[data-tooltip="Reply"]') || 
                               emailContainer.querySelector('[aria-label="Reply"]');
                               
                // Fallback: If contextual search fails, search the whole page
                if (!replyBtn) {
                    replyBtn = document.querySelector('div[data-tooltip="Reply"], .ams.bkH, [aria-label="Reply"]');
                }

                if (replyBtn) {
                    replyBtn.click(); // Opens the draft

                    // 2. Wait half a second for Gmail's compose window UI to render
                    setTimeout(() => {
                        const activeCompose = document.querySelector('.M9, [role="dialog"], table.aoI');
                        if (activeCompose) {
                            chrome.runtime.sendMessage({ action: 'getMyPublicKey' }, (res) => {
                                if (res && res.success) {
                                    const replyArea = activeCompose.querySelector('.Am.Al.editable');
                                    
                                    // 3. Drop the key in
                                    replyArea.innerText = "Here is my public key! We can now communicate securely.\n\n" + res.publicKey;

                                    // 4. Automatically hit Send
                                    setTimeout(() => {
                                        const sendBtn = activeCompose.querySelector('.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3') || activeCompose.querySelector('div[role="button"][data-tooltip*="Send"]');
                                        if (sendBtn) sendBtn.click();
                                        
                                        btn.innerText = "✅ Key Sent!";
                                        btn.style.background = "#34a853";
                                        btn.style.color = "white";
                                    }, 150);
                                } else if (res && res.error === "SESSION_LOCKED") {
                                    btn.innerText = "⚡ Send My Key Back Automatically"; // Reset button
                                    showUnlockModal(() => { btn.click(); }); // Prompt unlock, then auto-retry!
                                } else {
                                    btn.innerText = "⚡ Send My Key Back Automatically";
                                    alert("Failed to fetch your key. Did you generate one in the popup?");
                                }
                            });
                        }
                    }, 500); 
                } else {
                    alert("Could not find the Reply button. Please click Reply manually and use the 'Attach My Key' button.");
                    btn.innerText = "⚡ Send My Key Back Automatically";
                }
            };

            // Inject the banner above the email body
            body.insertAdjacentElement('beforebegin', banner);
        }
    });
}

async function checkFirstTimeUser() {
    const data = await chrome.storage.local.get(['myPublicKey', 'myEncryptedPrivateKey']);
    if (!data.myPublicKey || !data.myEncryptedPrivateKey) {
        if (document.getElementById('e2ee-onboarding-overlay')) return;
        injectOnboardingModal();
    }
}

function injectOnboardingModal() {
    const overlay = document.createElement('div'); overlay.id = 'e2ee-onboarding-overlay';
    overlay.style.cssText = "position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.6); z-index: 999999; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); font-family: sans-serif;";
    const modal = document.createElement('div'); modal.style.cssText = "background: white; width: 400px; padding: 30px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.15); text-align: center; box-sizing: border-box;";
    modal.innerHTML = `<div style="font-size: 24px; font-weight: bold; color: #1a73e8; margin-bottom: 8px;">🔐 Secure Setup</div><div style="font-size: 14px; color: #5f6368; margin-bottom: 24px;">Generate encryption keys to start sending secure emails.</div><input type="text" id="ob-name" placeholder="Full Name" style="width: 100%; padding: 10px; margin-bottom: 12px; border: 1px solid #dadce0; border-radius: 4px;"><input type="email" id="ob-email" placeholder="Email Address" style="width: 100%; padding: 10px; margin-bottom: 12px; border: 1px solid #dadce0; border-radius: 4px;"><input type="password" id="ob-passphrase" placeholder="Create Secret Passphrase" style="width: 100%; padding: 10px; margin-bottom: 20px; border: 1px solid #dadce0; border-radius: 4px;"><button id="ob-btn-generate" style="width: 100%; padding: 12px; background: #1a73e8; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">Generate Key Pair</button><div id="ob-status" style="margin-top: 15px; font-size: 13px; color: #1a73e8; font-weight: 500;"></div>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const genBtn = modal.querySelector('#ob-btn-generate'); const statusEl = modal.querySelector('#ob-status');
    genBtn.onclick = () => {
        const name = modal.querySelector('#ob-name').value.trim(); const email = modal.querySelector('#ob-email').value.trim(); const passphrase = modal.querySelector('#ob-passphrase').value;
        if (!name || !email || !passphrase) { statusEl.style.color = '#c5221f'; statusEl.innerText = "❌ Please fill out all fields."; return; }
        statusEl.innerText = "⏳ Generating cryptographic keys...";
        chrome.runtime.sendMessage({ action: 'generateKeys', name, email, passphrase }, (response) => {
            if (response && response.success) {
                chrome.runtime.sendMessage({ action: 'unlockSession', passphrase }, () => { setTimeout(() => { overlay.remove(); alert("Setup complete!"); }, 1500); });
            } else { statusEl.innerText = "❌ Error: " + response?.error; }
        });
    };
}

function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// --- 4. RUNTIME SYSTEM MOTOR (WITH HEARTBEAT & DEBOUNCE) ---
function runSafeScan() {
    if (!chrome.runtime || !chrome.runtime.id) return;
    
    checkFirstTimeUser();
    scanForKeys();
    injectCryptoControls();
    scanAndDecryptMessages();
    scanAndVerifySignatures();
    scanForKeyRequests();
}

// Ensure we don't choke the browser with thousands of checks during heavy Gmail animations
let scanTimeout = null;
const observer = new MutationObserver(() => {
    if (!chrome.runtime || !chrome.runtime.id) {
        observer.disconnect();
        return;
    }
    
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(runSafeScan, 150); // Wait 150ms for layout to settle
});

if (chrome.runtime && chrome.runtime.id) {
    observer.observe(document.body, { childList: true, subtree: true });
    
    // Heartbeat pulse to catch sneaky background CSS changes when reopening emails
    setInterval(runSafeScan, 1000);
}