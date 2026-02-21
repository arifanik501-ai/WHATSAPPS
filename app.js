// --- Globals & State ---
let currentUser = null;
let partnerUser = null;
let isEditing = false;
let replyToMsgId = null;
let selectedMsgId = null;
let typingTimeout = null;
let messagesList = {};

// --- Profile Globals ---
let usersProfile = {
    user1: { name: 'Anik', dp: '' },
    user2: { name: 'BEHULA', dp: '' }
};
let tempProfileDP = null;

// --- Local Storage Helpers ---
const MSG_KEY = 'wa_clone_messages';
const PRESENCE_KEY = 'wa_clone_presence';
const TYPING_KEY = 'wa_clone_typing';

let pendingDeletions = {};

function getLocalData(key, def) {
    const val = localStorage.getItem(key);
    return val ? JSON.parse(val) : def;
}

function setLocalData(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
}

// --- Firebase Setup ---
const firebaseConfig = {
    apiKey: "AIzaSyB0m0RnL66ad2YmPkEb7mGocN7zfmw8vtA",
    authDomain: "task-manager-4b27d.firebaseapp.com",
    projectId: "task-manager-4b27d",
    storageBucket: "task-manager-4b27d.firebasestorage.app",
    messagingSenderId: "231912940312",
    appId: "1:231912940312:web:515b653c667339360b346d",
    measurementId: "G-QDVYDL5SBN",
    databaseURL: "https://task-manager-4b27d-default-rtdb.asia-southeast1.firebasedatabase.app"
};

// Initialize Firebase
try {
    firebase.initializeApp(firebaseConfig);
} catch (e) {
    console.error("Firebase init error", e);
}
const db = firebase.database();
const messagesRef = db.ref('chat/messages');
const usersRef = db.ref('chat/users');

// --- Sync Operations ---
let clearingChat = false;
let isFirstSyncComplete = false;

function startAutoSync() {
    // Initial fetch to handle cleared chats while offline, and to set isFirstSyncComplete
    messagesRef.once('value').then(snap => {
        isFirstSyncComplete = true;
        const remoteData = snap.val() || {};
        const localData = getLocalData(MSG_KEY, {});

        // If remote is completely empty but local has messages, someone cleared the chat
        if (Object.keys(remoteData).length === 0 && Object.keys(localData).length > 0) {
            setLocalData(MSG_KEY, {});
            messagesList = {};
            const chatBody = document.getElementById('chat-body');
            if (chatBody) {
                chatBody.querySelectorAll('.message-row, .date-badge').forEach(r => r.remove());
            }
            loadAllMessages();
        }
    });

    // Listen for new messages
    messagesRef.on('child_added', snap => {
        if (clearingChat) return;
        const key = snap.key;
        const rMsg = snap.val();
        const localData = getLocalData(MSG_KEY, {});

        let changed = false;
        if (!localData[key]) {
            localData[key] = rMsg;
            changed = true;
        } else {
            changed = mergeMessage(localData[key], rMsg);
        }

        if (changed) {
            setLocalData(MSG_KEY, localData);
            loadAllMessages();
        }
    });

    // Listen for updated messages (read receipts, deletions, reactions)
    messagesRef.on('child_changed', snap => {
        if (clearingChat) return;
        const key = snap.key;
        const rMsg = snap.val();
        const localData = getLocalData(MSG_KEY, {});

        if (localData[key]) {
            if (mergeMessage(localData[key], rMsg)) {
                setLocalData(MSG_KEY, localData);
                loadAllMessages();
            }
        }
    });

    // Listen for completely deleted messages
    messagesRef.on('child_removed', snap => {
        if (clearingChat) return;
        const key = snap.key;
        const localData = getLocalData(MSG_KEY, {});

        if (localData[key]) {
            delete localData[key];
            setLocalData(MSG_KEY, localData);

            const row = document.getElementById(`msg-${key}`);
            if (row) row.remove();
            delete messagesList[key];
        }
    });
}

function mergeMessage(lMsg, rMsg) {
    let changed = false;
    if (rMsg.status !== lMsg.status) {
        lMsg.status = rMsg.status;
        changed = true;
    }
    if (rMsg.deleted && !lMsg.deleted) {
        lMsg.deleted = true;
        changed = true;
    }
    if (rMsg.edited && rMsg.text !== lMsg.text) {
        lMsg.text = rMsg.text;
        lMsg.edited = true;
        changed = true;
    }
    if (rMsg.reactions) {
        if (JSON.stringify(rMsg.reactions) !== JSON.stringify(lMsg.reactions)) {
            lMsg.reactions = rMsg.reactions;
            changed = true;
        }
    }
    if (rMsg.deletedFor) {
        if (!lMsg.deletedFor) lMsg.deletedFor = [];
        const remoteDeletedFor = Array.isArray(rMsg.deletedFor) ? rMsg.deletedFor : Object.values(rMsg.deletedFor);
        for (let d of remoteDeletedFor) {
            if (d && !lMsg.deletedFor.includes(d)) {
                lMsg.deletedFor.push(d);
                changed = true;
            }
        }
    }
    return changed;
}

function syncLocalToFirebase() {
    if (clearingChat) return;
    const localData = getLocalData(MSG_KEY, {});
    if (Object.keys(localData).length === 0) return;
    messagesRef.update(localData);
}

// Push a single message to Firebase instantly
function pushSingleMessage(msgId, msgData) {
    if (clearingChat) return;
    messagesRef.child(msgId).set(msgData);
}

// --- UI Operations ---
function initApp() {
    const savedUser = localStorage.getItem('chatUser');
    if (savedUser) {
        selectUser(savedUser);
    }

    // Fix emoji encoding display dynamically
    const catIcons = {
        'smileys': '😀', 'animals': '🐶', 'food': '🍔',
        'sports': '⚽', 'travel': '🚗', 'objects': '💡', 'symbols': '❤️'
    };
    document.querySelectorAll('.emoji-cat').forEach(cat => {
        const type = cat.getAttribute('onclick').match(/'([^']+)'/)[1];
        if (catIcons[type]) cat.innerText = catIcons[type];
    });

    loadEmojis('smileys');

    // Cross-tab synchronization
    window.addEventListener('storage', handleStorageChange);

    // Periodically cleanup stale typing statuses
    setInterval(cleanupTyping, 3000);

    startProfileSync();
    startAutoSync();
}

function handleUserSelection(event, userId) {
    const btn = event.currentTarget;

    // 1. Create Ripple
    const ripple = document.createElement('span');
    ripple.classList.add('ripple');
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = `${size}px`;
    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    btn.appendChild(ripple);

    setTimeout(() => ripple.remove(), 600);

    // 2. Show Password Prompt for Anik (user1)
    if (userId === 'user1') {
        setTimeout(() => {
            const pwdModal = document.getElementById('password-modal');
            pwdModal.style.display = 'flex';
            // Slight delay before active class for transition
            setTimeout(() => {
                pwdModal.classList.add('active');
                document.getElementById('anik-password').focus();
            }, 10);
        }, 150);
        return;
    }

    // 3. Normal Flow for BEHULA
    proceedWithUserSelection(userId);
}

function proceedWithUserSelection(userId) {
    const userName = userId === 'user1' ? 'Anik' : 'BEHULA';
    document.getElementById('popup-user-name').innerText = userName;
    const popupOverlay = document.getElementById('selection-popup-overlay');
    popupOverlay.classList.add('active');

    setTimeout(() => {
        popupOverlay.classList.add('closing');
        setTimeout(() => {
            popupOverlay.classList.remove('active', 'closing');
            selectUser(userId);
        }, 200);
    }, 800);
}

function verifyPassword() {
    const pwdInput = document.getElementById('anik-password');
    const errorMsg = document.getElementById('password-error');
    const val = pwdInput.value;

    if (val === 'Arif1@') {
        const modal = document.getElementById('password-modal');
        pwdInput.blur();
        // Success flash
        pwdInput.style.backgroundColor = '#d1f4cc';
        setTimeout(() => {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
                pwdInput.value = '';
                pwdInput.style.backgroundColor = '';
                proceedWithUserSelection('user1');
            }, 300);
        }, 300);
    } else {
        // Error Shake
        pwdInput.classList.add('shake-error');
        errorMsg.classList.add('visible');
        setTimeout(() => {
            pwdInput.classList.remove('shake-error');
        }, 300);
        setTimeout(() => {
            pwdInput.value = '';
            errorMsg.classList.remove('visible');
        }, 1500);
    }
}

function togglePasswordVisibility() {
    const input = document.getElementById('anik-password');
    if (input.type === 'password') {
        input.type = 'text';
    } else {
        input.type = 'password';
    }
}

function selectUser(userId) {
    currentUser = userId;
    partnerUser = userId === 'user1' ? 'user2' : 'user1';
    localStorage.setItem('chatUser', userId);

    document.getElementById('landing-page').style.display = 'none';
    document.getElementById('chat-page').style.display = 'flex';
    document.getElementById('chat-partner-name').innerText = partnerUser === 'user1' ? 'Anik' : 'BEHULA';

    updatePresence(true);
    loadAllMessages();
    renderPresence();
}

function showLanding() {
    if (currentUser) {
        updatePresence(false);
    }
    document.getElementById('chat-page').style.display = 'none';
    document.getElementById('landing-page').style.display = 'flex';
    localStorage.removeItem('chatUser');
    currentUser = null;
    partnerUser = null;
    document.getElementById('chat-body').innerHTML = `
        <div class="encryption-banner">
            🔒 Messages are end-to-end encrypted. No one outside of this chat can read or listen to them.
        </div>
        <div class="typing-bubble" id="typing-indicator">
            <div class="dot"></div><div class="dot"></div><div class="dot"></div>
        </div>`;
    messagesList = {};
}

function updatePresence(isOnline) {
    if (!currentUser) return;
    const p = getLocalData(PRESENCE_KEY, {});
    p[currentUser] = {
        online: isOnline,
        lastSeen: Date.now()
    };
    setLocalData(PRESENCE_KEY, p);
    renderPresence();
}

function updateTyping(isTyping) {
    if (!currentUser) return;
    const t = getLocalData(TYPING_KEY, {});
    t[currentUser] = isTyping ? Date.now() : 0;
    setLocalData(TYPING_KEY, t);
}

function cleanupTyping() {
    const t = getLocalData(TYPING_KEY, {});
    let changed = false;
    const now = Date.now();
    for (let user in t) {
        if (t[user] && now - t[user] > 3000) {
            t[user] = 0;
            changed = true;
        }
    }
    if (changed) setLocalData(TYPING_KEY, t);
    if (partnerUser) renderTyping(t[partnerUser]);
}

window.addEventListener('beforeunload', () => {
    if (currentUser) updatePresence(false);
});

function handleStorageChange(e) {
    if (e.key === MSG_KEY) {
        loadAllMessages();
    } else if (e.key === PRESENCE_KEY) {
        renderPresence();
    } else if (e.key === TYPING_KEY) {
        const t = getLocalData(TYPING_KEY, {});
        if (partnerUser) renderTyping(t[partnerUser]);
    }
}

function loadAllMessages() {
    if (!currentUser) return;

    const allMsgs = getLocalData(MSG_KEY, {});
    let needsScroll = false;
    let markRead = false;
    let currentPinnedMsg = null;
    let validMessagesCount = 0; // Counter for non-deleted messages

    // Remove deleted messages
    for (const msgId in messagesList) {
        if (!allMsgs[msgId] || (allMsgs[msgId].deletedFor && allMsgs[msgId].deletedFor.includes(currentUser))) {
            const row = document.getElementById(`msg-${msgId}`);
            if (row) row.remove();
            delete messagesList[msgId];
        }
    }

    for (const msgId in allMsgs) {
        const msg = allMsgs[msgId];

        // Skip rendering if pending deletion locally
        if (pendingDeletions[msgId]) continue;

        // Skip rendering if deleted for me
        if (msg.deletedFor && msg.deletedFor.includes(currentUser)) continue;

        validMessagesCount++; // Increment count for valid messages

        if (msg.pinned && !msg.deleted) {
            currentPinnedMsg = { id: msgId, text: msg.image ? '📷 Photo' : msg.text, sender: msg.sender };
        }

        if (!messagesList[msgId]) {
            // New message
            addMessageToDOM(msgId, msg);
            needsScroll = true;

            if (msg.sender === partnerUser && msg.status !== 'read') {
                msg.status = 'read';
                // Push read status instantly for this message only
                messagesRef.child(msgId).update({ status: 'read' });
            }
        } else {
            // Updated message
            if (JSON.stringify(messagesList[msgId]) !== JSON.stringify(msg)) {
                updateMessageDOM(msgId, msg);
            }
        }

        messagesList[msgId] = JSON.parse(JSON.stringify(msg));
    }

    if (markRead) {
        setLocalData(MSG_KEY, allMsgs);
    }
    if (needsScroll) {
        scrollToBottom();
    }

    // Show/hide empty state
    const emptyState = document.getElementById('empty-chat-state');
    if (emptyState) {
        emptyState.style.display = validMessagesCount === 0 ? 'flex' : 'none';
    }

    // Update Pinned Banner
    const pBanner = document.getElementById('pinned-banner');
    if (currentPinnedMsg) {
        document.getElementById('pinned-text').innerText = escapeHTML(currentPinnedMsg.text) || 'Pinned Message';
        pBanner.style.display = 'flex';
        pBanner.onclick = function (e) {
            if (!e.target.closest('.pinned-close')) {
                scrollToMsg(currentPinnedMsg.id);
            }
        };
    } else {
        pBanner.style.display = 'none';
        pBanner.onclick = null;
    }

    applyGroupingLogic();
}

function applyGroupingLogic() {
    const rows = Array.from(document.querySelectorAll('.message-row'));
    const visibleRows = rows.filter(r => r.style.display !== 'none');

    for (let i = 0; i < visibleRows.length; i++) {
        const row = visibleRows[i];
        const prevRow = visibleRows[i - 1];
        const nextRow = visibleRows[i + 1];

        // Exclude system messages or non-standard bubbles if any, but currently all are tracked.
        const isSent = row.classList.contains('sent');
        const prevIsSent = prevRow ? prevRow.classList.contains('sent') : null;
        const nextIsSent = nextRow ? nextRow.classList.contains('sent') : null;

        let isFirst = prevIsSent !== isSent;
        let isLast = nextIsSent !== isSent;

        row.classList.remove('first-in-group', 'middle-in-group', 'last-in-group');

        if (isFirst && isLast) {
            row.classList.add('first-in-group', 'last-in-group');
        } else if (isFirst) {
            row.classList.add('first-in-group');
        } else if (isLast) {
            row.classList.add('last-in-group');
        } else {
            row.classList.add('middle-in-group');
        }
    }
}

function renderPresence() {
    if (!partnerUser) return;
    const p = getLocalData(PRESENCE_KEY, {});
    const data = p[partnerUser];
    const statusEl = document.getElementById('chat-partner-status');
    const typingEl = document.getElementById('header-typing');

    const t = getLocalData(TYPING_KEY, {});
    if (t[partnerUser] && t[partnerUser] > Date.now() - 5000) {
        statusEl.style.display = 'none';
        typingEl.style.display = 'flex';
        return;
    }

    typingEl.style.display = 'none';
    statusEl.style.display = 'block';

    if (data && data.online) {
        statusEl.innerText = 'Online';
        statusEl.style.color = 'white';
        markMessagesAsRead();
    } else if (data && data.lastSeen) {
        statusEl.innerText = 'last seen ' + formatTime(data.lastSeen);
        statusEl.style.color = 'rgba(255, 255, 255, 0.9)';
    } else {
        statusEl.innerText = 'Offline';
        statusEl.style.color = 'rgba(255, 255, 255, 0.9)';
    }
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerText = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
}

function toggleMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('main-menu');
    menu.classList.toggle('active');
}

document.addEventListener('click', (e) => {
    document.getElementById('main-menu').classList.remove('active');
    document.getElementById('context-menu').classList.remove('active');
});

const input = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const sendIcon = document.getElementById('send-icon');
const cameraBtn = document.getElementById('camera-btn');

function handleInput() {
    input.style.height = 'auto';
    input.style.height = (input.scrollHeight < 100 ? input.scrollHeight : 100) + 'px';

    if (input.value.trim() !== '') {
        sendIcon.innerHTML = '<use href="#icon-send"/>';
        cameraBtn.style.display = 'none';
        sendIcon.style.transform = 'rotate(0deg)';
    } else {
        sendIcon.innerHTML = '<use href="#icon-mic"/>';
        cameraBtn.style.display = 'flex';
        sendIcon.style.transform = 'scale(1)';
    }

    if (currentUser) {
        updateTyping(true);
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            updateTyping(false);
        }, 2000);
    }
}

input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

function formatTime(timestamp) {
    const date = new Date(timestamp);
    let hours = date.getHours();
    let minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    minutes = minutes < 10 ? '0' + minutes : minutes;
    return hours + ':' + minutes + ' ' + ampm;
}

// --- Send Sound (Web Audio API) ---
function playSendSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.12);
    } catch (e) { }
}

function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    playSendSound();

    const msgId = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 7);
    const msgData = {
        text: text,
        sender: currentUser,
        status: 'sent',
        timestamp: Date.now(),
        replyTo: replyToMsgId,
        deleted: false,
        deletedFor: []
    };

    const allMsgs = getLocalData(MSG_KEY, {});
    allMsgs[msgId] = msgData;
    setLocalData(MSG_KEY, allMsgs);

    // Render immediately, sync in background
    loadAllMessages();
    scrollToBottom(true);

    input.value = '';
    input.style.height = 'auto';
    handleInput();
    cancelReply();
    updateTyping(false);

    // Push only this message to Firebase (fast, no overwrite)
    pushSingleMessage(msgId, msgData);
}

function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (event) {
        const img = new Image();
        img.onload = function () {
            const canvas = document.createElement('canvas');
            const MAX_WIDTH = 800;
            const MAX_HEIGHT = 800;
            let width = img.width;
            let height = img.height;

            if (width > height) {
                if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
            } else {
                if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);

            const msgId = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 7);
            const msgData = {
                text: '',
                image: dataUrl,
                sender: currentUser,
                status: 'sent',
                timestamp: Date.now(),
                replyTo: replyToMsgId,
                deleted: false,
                deletedFor: []
            };

            const allMsgs = getLocalData(MSG_KEY, {});
            allMsgs[msgId] = msgData;
            setLocalData(MSG_KEY, allMsgs);

            syncLocalToFirebase();
            loadAllMessages();
            cancelReply();

            setTimeout(() => { scrollToBottom(true); }, 150);
        }
        img.src = event.target.result;
    }
    reader.readAsDataURL(file);
    e.target.value = ''; // Reset
}

function addMessageToDOM(msgId, msg) {
    const chatBody = document.getElementById('chat-body');
    let row = document.getElementById(`msg-${msgId}`);

    if (!row) {
        row = document.createElement('div');
        row.id = `msg-${msgId}`;
        chatBody.insertBefore(row, document.getElementById('typing-indicator'));

        if (msg.sender !== currentUser && msg.timestamp > Date.now() - 5000) {
            playNotifSound();
        }
    }

    row.className = `message-row ${msg.sender === currentUser ? 'sent' : 'received'}`;

    let tickHTML = '';
    if (msg.sender === currentUser) {
        if (msg.status === 'read') tickHTML = `<svg class="tick-icon"><use href="#tick-double" class="tick-read"></use></svg>`;
        else if (msg.status === 'delivered') tickHTML = `<svg class="tick-icon"><use href="#tick-double" class="tick-delivered"></use></svg>`;
        else tickHTML = `<svg class="tick-icon"><use href="#tick-single" class="tick-sent"></use></svg>`;
    }

    let replyHTML = '';
    if (msg.replyTo && messagesList[msg.replyTo] && (!messagesList[msg.replyTo].deletedFor || !messagesList[msg.replyTo].deletedFor.includes(currentUser))) {
        const quoted = messagesList[msg.replyTo];
        const senderName = quoted.sender === currentUser ? 'You' : (partnerUser === 'user1' ? 'Anik' : 'BEHULA');
        let quotedPreview = escapeHTML(quoted.text);
        if (quoted.image && !quoted.text) quotedPreview = '📷 Photo';
        replyHTML = `
            <div class="quoted-msg" onclick="scrollToMsg('${msg.replyTo}')">
                <div class="quoted-sender">${senderName}</div>
                <div class="quoted-text">${quoted.deleted ? '🚫 This message was deleted' : quotedPreview}</div>
            </div>
        `;
    }

    let textContent = '';
    if (msg.image) {
        textContent += `<img src="${msg.image}" class="message-image" onclick="openImageViewer(this.src)" />`;
    }
    if (msg.text) {
        let editedMark = msg.edited ? `<span class="message-edited"> (edited)</span>` : '';
        textContent += escapeHTML(msg.text).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>') + editedMark;
    }

    if (msg.deleted) {
        textContent = `<span class="deleted-text">🚫 This message was deleted</span>`;
    }

    let reactionHTML = '';
    if (msg.reactions && msg.reactions.length > 0) {
        reactionHTML = `<div class="message-reaction-badge">${msg.reactions.join('')}</div>`;
    }

    let fullTimeString = new Date(msg.timestamp || Date.now()).toLocaleString([], {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });

    row.innerHTML = `
        <div class="message-bubble" data-timestamp="${fullTimeString}" ondblclick="handleEditMessage(event, '${msgId}')" oncontextmenu="openContextMenu(event, '${msgId}')" ontouchstart="handleTouchStart(event, '${msgId}')" ontouchend="handleTouchEnd(event)">
            ${replyHTML}
            <div class="message-text">${textContent}</div>
            <div class="message-meta">
                <span class="message-time">${formatTime(msg.timestamp || Date.now())}</span>
                ${tickHTML}
            </div>
            ${reactionHTML}
        </div>
    `;
}

function scrollToBottom(smooth = false) {
    const body = document.getElementById('chat-body');
    if (smooth) {
        body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
    } else {
        body.scrollTop = body.scrollHeight;
    }
    document.getElementById('scroll-bottom').classList.remove('visible');
}

// --- Image Viewer ---
function openImageViewer(src) {
    const viewer = document.getElementById('image-viewer');
    const img = document.getElementById('viewer-img');
    img.src = src;
    viewer.classList.add('active');
}

function closeImageViewer(e) {
    if (e && e.target && (e.target.closest('.image-viewer-header') || e.target.id === 'viewer-img')) return;
    document.getElementById('image-viewer').classList.remove('active');
}

function downloadViewerImage() {
    const img = document.getElementById('viewer-img');
    const link = document.createElement('a');
    link.href = img.src;
    link.download = 'whatsapp_image_' + Date.now() + '.png';
    link.click();
}

function handleScroll() {
    const body = document.getElementById('chat-body');
    const btn = document.getElementById('scroll-bottom');
    if (body.scrollHeight - body.scrollTop > body.clientHeight + 100) {
        btn.classList.add('visible');
    } else {
        btn.classList.remove('visible');
    }
}

function toggleEmojiPanel() {
    document.getElementById('emoji-panel').classList.toggle('active');
}

const emojis = {
    smileys: ['😀', '😂', '😊', '😍', '😘', '😎', '😭', '😡', '🤔', '😴', '😇', '🥳', '😉', '🙃', '😋', '😜', '🤪', '🤩', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😤', '😠', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '👾', '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾'],
    animals: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🦟', '🦗', '🕷', '🕸', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐓', '🦃', '🦚', '🦜', '🦢', '🦩', '🕊', '🐇', '🦝', '🦨', '🦡', '🦦', '🦥', '🐁', '🐀', '🐿', '🦔'],
    food: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶', '🌽', '🥕', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🥪', '🥙', '🧆', '🌮', '🌯', '🥗', '🥘', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🍼', '☕', '🍵', '🧃', '🥤', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🍾', '🧊', '🥄', '🍴', '🍽', '🥣', '🥡', '🥢', '🧂'],
    sports: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛷', '⛸', '🥌', '🎿', '⛷', '🏂', '🪂', '🏋️‍♀️', '🏋️', '🏋️‍♂️', '🤼‍♀️', '🤼', '🤼‍♂️', '🤸‍♀️', '🤸', '🤸‍♂️', '⛹️‍♀️', '⛹️', '⛹️‍♂️', '🤺', '🤾‍♀️', '🤾', '🤾‍♂️', '🏌️‍♀️', '🏌️', '🏌️‍♂️', '🏇', '🧘‍♀️', '🧘', '🧘‍♂️', '🏄‍♀️', '🏄', '🏄‍♂️', '🏊‍♀️', '🏊', '🏊‍♂️', '🤽‍♀️', '🤽', '🤽‍♂️', '🚣‍♀️', '🚣', '🚣‍♂️', '🧗‍♀️', '🧗', '🧗‍♂️', '🚵‍♀️', '🚵', '🚵‍♂️', '🚴‍♀️', '🚴', '🚴‍♂️', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖', '🏵', '🎗', '🎫', '🎟', '🎪', '🤹‍♀️', '🤹', '🤹‍♂️', '🎭', '🩰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🪕', '🎻', '🎲', '♟', '🎯', '🎳', '🎮', '🎰', '🧩'],
    travel: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🚚', '🚛', '🚜', '🦯', '🦽', '🦼', '🛴', '🚲', '🛵', '🏍', '🛺', '🚨', '🚔', '🚍', '🚘', '🚖', '🚡', '🚠', '🚟', '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉', '✈️', '🛫', '🛬', '🛩', '💺', '🛰', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤', '🛥', '🛳', '⛴', '🚢', '⚓', '⛽', '🚧', '🚦', '🚥', '🚏', '🗺', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟', '🎡', '🎢', '🎠', '⛲', '⛱', '🏖', '🏝', '🏜', '🌋', '⛰', '🏔', '🗻', '🏕', '⛺', '🏠', '🏡', '🏘', '🏚', '🏗', '🏭', '🏢', '🏬', '🏣', '🏤', '🏥', '🏦', '🏨', '🏪', '🏫', '🏩', '💒', '🏛', '⛪', '🕌', '🕍', '🛕', '🕋', '⛩', '🛤', '🛣', '🗾', '🎑', '🏞', '🌅', '🌄', '🌠', '🎇', '🎆', '🌇', '🌆', '🏙', '🌃', '🌌', '🌉', '🌁'],
    objects: ['💡', '🔦', '🏮', '📔', '📕', '📖', '📗', '📘', '📙', '📚', '📓', '📒', '📃', '📜', '📄', '📰', '🗞', '📑', '🔖', '🏷', '💰', '💴', '💵', '💶', '💷', '💸', '💳', '🧾', '✉️', '📧', '📨', '📩', '📤', '📥', '📦', '📫', '📪', '📬', '📭', '📮', '🗳', '✏️', '✒️', '🖋', '🖊', '🖌', '🖍', '📝', '💼', '📁', '📂', '🗂', '📅', '📆', '🗒', '🗓', '📇', '📈', '📉', '📊', '📋', '📌', '📍', '📎', '🖇', '📏', '📐', '✂️', '🗃', '🗄', '🗑', '🔒', '🔓', '🔏', '🔐', '🔑', '🗝', '🔨', '🪓', '⛏', '⚒', '🛠', '🗡', '⚔️', '🔫', '🪀', '🛡', '🔧', '🔩', '⚙️', '🗜', '⚖️', '🦯', '🔗', '⛓', '🧰', '🧲', '⚗️', '🧪', '🧫', '🧬', '🔬', '🔭', '📡', '💉', '🩸', '💊', '🩹', '🩺', '🚪', '🛏', '🛋', '🪑', '🚽', '🚿', '🛁', '🪒', '🧴', '🧷', '🧹', '🧺', '🧻', '🧼', '🧽', '🧯', '🛒', '🚬', '⚰️', '⚱️', '🗿'],
    symbols: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️', '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️', '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫', '💯', '💢', '♨️', '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗️', '❕', '❓', '❔', '‼️', '⁉️', '〽️', '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️', '✅', '🈯', '💹', '❇️', '✳️', '❎', '🌐', '💠', 'Ⓜ️', '🌀', '💤', '🏧', '🚾', '♿', '🅿️', '🈳', '🈂️', '🛂', '🛃', '🛄', '🛅', '🚹', '🚺', '🚼', '🚻', '🚮', '🎦', '📶', '🈁', '🔣', 'ℹ️', '🔤', '🔡', '🔠', '🆖', '🆗', '🆙', '🆒', '🆕', '🆓', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '🔢', '#️⃣', '*️⃣', '⏏️', '▶️', '⏸', '⏯', '⏹', '⏺', '⏭', '⏮', '⏩', '⏪', '⏫', '⏬', '◀️', '🔼', '🔽', '➡️', '⬅️', '⬆️', '⬇️', '↗️', '↘️', '↙️', '↖️', '↕️', '↔️', '↪️', '↩️', '⤴️', '⤵️', '🔀', '🔁', '🔂', '🔄', '🔃', '🎵', '🎶', '➕', '➖', '➗', '✖️', '♾', '💲', '💱', '™️', '©️', '®️', '👁‍🗨', '🔚', '🔙', '🔛', '🔝', '🔜', '〰️', '➰', '➿', '✔️', '☑️', '🔘', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤', '🔺', '🔻', '🔸', '🔹', '🔶', '🔷', '🔳', '🔲', '▪️', '▫️', '◾', '◽', '◼️', '◻️', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬛', '⬜', '🟫', '🔈', '🔇', '🔉', '🔊', '🔔', '🔕', '📣', '📢', '💬', '💭', '🗯', '♠️', '♣️', '♥️', '♦️', '🃏', '🎴', '🀄', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛', '🕜', '🕝', '🕞', '🕟', '🕠', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦', '🕧']
};

function loadEmojis(category) {
    document.querySelectorAll('.emoji-cat').forEach(c => c.classList.remove('active-cat'));

    // Safely apply active class to the clicked tab, or default to first tab on load
    if (typeof event !== 'undefined' && event && event.type === 'click') {
        let el = event.currentTarget || event.target;
        if (el.closest) el = el.closest('.emoji-cat') || el;
        if (el && el.classList) el.classList.add('active-cat');
    } else if (category === 'smileys') {
        const cats = document.querySelectorAll('.emoji-cat');
        if (cats.length > 0) cats[0].classList.add('active-cat');
    }

    const grid = document.getElementById('emoji-grid');
    grid.innerHTML = '';
    emojis[category].forEach(e => {
        const span = document.createElement('div');
        span.className = 'emoji-item';
        span.innerText = e;
        span.onclick = () => {
            input.value += e;
            handleInput();
        };
        grid.appendChild(span);
    });
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g,
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])
    );
}

function markMessagesAsRead() {
    const allMsgs = getLocalData(MSG_KEY, {});
    let changed = false;
    for (const key in allMsgs) {
        if (allMsgs[key].sender === partnerUser && allMsgs[key].status !== 'read') {
            allMsgs[key].status = 'read';
            changed = true;
        }
    }
    if (changed) {
        setLocalData(MSG_KEY, allMsgs);
        syncLocalToFirebase(); // Sync read status back
        loadAllMessages();
    }
}

function updateMessageDOM(msgId, msg) {
    const row = document.getElementById(`msg-${msgId}`);
    if (!row) return;

    const bubble = row.querySelector('.message-bubble');
    if (bubble) {
        let fullTimeString = new Date(msg.timestamp || Date.now()).toLocaleString([], {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
        bubble.setAttribute('data-timestamp', fullTimeString);
    }

    let tickHTML = '';
    if (msg.sender === currentUser) {
        if (msg.status === 'read') tickHTML = `<svg class="tick-icon"><use href="#tick-double" class="tick-read"></use></svg>`;
        else if (msg.status === 'delivered') tickHTML = `<svg class="tick-icon"><use href="#tick-double" class="tick-delivered"></use></svg>`;
        else tickHTML = `<svg class="tick-icon"><use href="#tick-single" class="tick-sent"></use></svg>`;
    }

    const metaDiv = row.querySelector('.message-meta');
    if (metaDiv) {
        metaDiv.innerHTML = `<span class="message-time">${formatTime(msg.timestamp || Date.now())}</span>${tickHTML}`;
    }

    let badge = row.querySelector('.message-reaction-badge');
    if (msg.reactions && msg.reactions.length > 0) {
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'message-reaction-badge';
            row.querySelector('.message-bubble').appendChild(badge);
        }
        badge.innerHTML = msg.reactions.join('');
    } else if (badge) {
        badge.remove();
    }

    // Handle edited text update
    if (!msg.deleted && msg.text) {
        const textDiv = row.querySelector('.message-text');
        if (textDiv && !textDiv.querySelector('input')) {
            let editedMark = msg.edited ? `<span class="message-edited"> (edited)</span>` : '';
            textDiv.innerHTML = escapeHTML(msg.text).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>') + editedMark;
        }
    }

    if (msg.deleted) {
        const textDiv = row.querySelector('.message-text');
        if (textDiv) textDiv.innerHTML = `<span class="deleted-text">🚫 This message was deleted</span>`;
        const quotedDiv = row.querySelector('.quoted-msg');
        if (quotedDiv) quotedDiv.remove();
        const img = row.querySelector('.message-image');
        if (img) img.remove();
        if (badge) badge.remove();
    }
}

function handleEditMessage(e, msgId) {
    const allMsgs = getLocalData(MSG_KEY, {});
    const msg = allMsgs[msgId];

    // Only allow editing sent text messages
    if (!msg || msg.deleted || msg.sender !== currentUser || msg.image) return;

    const row = document.getElementById(`msg-${msgId}`);
    if (!row) return;

    const textDiv = row.querySelector('.message-text');
    if (!textDiv || textDiv.querySelector('input')) return;

    const originalText = msg.text;
    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'edit-message-input';
    inputEl.value = originalText;

    textDiv.innerHTML = '';
    textDiv.appendChild(inputEl);
    inputEl.focus();

    inputEl.onkeydown = function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            const newText = inputEl.value.trim();
            if (newText && newText !== originalText) {
                msg.text = newText;
                msg.edited = true;
                setLocalData(MSG_KEY, allMsgs);
                syncLocalToFirebase();
                loadAllMessages();
            } else {
                loadAllMessages(); // Revert
            }
        } else if (event.key === 'Escape') {
            loadAllMessages(); // Revert
        }
    };

    inputEl.onblur = function () {
        loadAllMessages(); // Revert if click away
    };
}

let touchStartX = 0;
let touchTimer = null;

function handleTouchStart(e, msgId) {
    touchStartX = e.touches[0].clientX;
    touchTimer = setTimeout(() => {
        openContextMenu(e, msgId);
    }, 500);
}

function handleTouchEnd(e) {
    clearTimeout(touchTimer);
}

function handleReply() {
    if (!selectedMsgId || !messagesList[selectedMsgId]) return;
    const msg = messagesList[selectedMsgId];
    if (msg.deleted) return;

    replyToMsgId = selectedMsgId;
    const preview = document.getElementById('reply-preview');
    document.getElementById('reply-name').innerText = msg.sender === currentUser ? 'You' : (partnerUser === 'user1' ? 'Anik' : 'BEHULA');

    let previewText = msg.text;
    if (msg.image && !msg.text) previewText = '📷 Photo';
    document.getElementById('reply-text').innerText = previewText;

    preview.classList.add('active');
    input.focus();

    document.getElementById('context-menu').classList.remove('active');
}

function cancelReply() {
    replyToMsgId = null;
    document.getElementById('reply-preview').classList.remove('active');
}

function handleCopy() {
    if (!selectedMsgId || !messagesList[selectedMsgId] || messagesList[selectedMsgId].deleted) return;
    navigator.clipboard.writeText(messagesList[selectedMsgId].text).then(() => {
        showToast("Copied!");
    });
    document.getElementById('context-menu').classList.remove('active');
}

function handlePinToggle() {
    if (!selectedMsgId) return;
    const allMsgs = getLocalData(MSG_KEY, {});
    const msg = allMsgs[selectedMsgId];
    if (msg && !msg.deleted) {
        const wasPinned = msg.pinned;
        // Unpin all first
        for (const key in allMsgs) {
            allMsgs[key].pinned = false;
        }
        // Toggle if not previously pinned
        if (!wasPinned) {
            allMsgs[selectedMsgId].pinned = true;
        }
        setLocalData(MSG_KEY, allMsgs);
        syncLocalToFirebase();
        loadAllMessages();
    }
    document.getElementById('context-menu').classList.remove('active');
}

function unpinMessage(e) {
    if (e) e.stopPropagation();
    const allMsgs = getLocalData(MSG_KEY, {});
    let changed = false;
    for (const key in allMsgs) {
        if (allMsgs[key].pinned) {
            allMsgs[key].pinned = false;
            changed = true;
        }
    }
    if (changed) {
        setLocalData(MSG_KEY, allMsgs);
        syncLocalToFirebase();
        loadAllMessages();
    }
}

function handleDeletePrompt() {
    if (!selectedMsgId) return;
    const msg = messagesList[selectedMsgId];

    document.getElementById('context-menu').classList.remove('active');
    document.getElementById('dialog-overlay').classList.add('active');
    document.getElementById('dialog-title').innerText = "Delete message?";

    let html = `<div class="dialog-option" onclick="deleteMessage('forMe')">Delete for me</div>`;
    if (msg.sender === currentUser) {
        html = `<div class="dialog-option danger" onclick="deleteMessage('forEveryone')">Delete for everyone</div>` + html;
    }
    document.getElementById('dialog-body').innerHTML = html;
}

function deleteMessage(type) {
    if (!selectedMsgId) return;
    const msgId = selectedMsgId;
    closeDialog();

    // Shrink animation
    const row = document.getElementById(`msg-${msgId}`);
    if (row) {
        row.style.transition = 'all 300ms ease';
        row.style.transform = 'scale(0.8)';
        row.style.opacity = '0';
        setTimeout(() => {
            row.style.display = 'none';
            applyGroupingLogic();
        }, 300);
    }

    showUndoToast(msgId, type);
}

function showUndoToast(msgId, type) {
    const toast = document.getElementById('undo-toast');
    if (!toast) return;

    toast.style.display = 'flex';
    void toast.offsetWidth; // Trigger reflow
    toast.classList.add('show');

    if (pendingDeletions[msgId]) clearTimeout(pendingDeletions[msgId].timer);

    const timer = setTimeout(() => {
        executeDeletion(msgId, type);
        toast.classList.remove('show');
        setTimeout(() => {
            if (!document.querySelector('.undo-toast.show')) toast.style.display = 'none';
        }, 300);
        delete pendingDeletions[msgId];
    }, 5000);

    pendingDeletions[msgId] = { type, timer };

    const undoBtn = document.getElementById('undo-btn');
    undoBtn.onclick = function () {
        undoDeletion(msgId);
        toast.classList.remove('show');
        setTimeout(() => {
            if (!document.querySelector('.undo-toast.show')) toast.style.display = 'none';
        }, 300);
    };
}

function undoDeletion(msgId) {
    if (pendingDeletions[msgId]) {
        clearTimeout(pendingDeletions[msgId].timer);
        delete pendingDeletions[msgId];
    }

    const row = document.getElementById(`msg-${msgId}`);
    if (row) {
        row.style.display = '';
        void row.offsetWidth; // Trigger reflow
        row.style.transform = 'scale(1)';
        row.style.opacity = '1';
        applyGroupingLogic();
    }
}

function executeDeletion(msgId, type) {
    const allMsgs = getLocalData(MSG_KEY, {});

    if (type === 'forEveryone') {
        if (allMsgs[msgId]) {
            allMsgs[msgId].deleted = true;
            allMsgs[msgId].text = null;
            allMsgs[msgId].image = null;
        }
    } else {
        if (allMsgs[msgId]) {
            if (!allMsgs[msgId].deletedFor) allMsgs[msgId].deletedFor = [];
            if (!allMsgs[msgId].deletedFor.includes(currentUser)) {
                allMsgs[msgId].deletedFor.push(currentUser);
            }
        }
    }

    setLocalData(MSG_KEY, allMsgs);
    syncLocalToFirebase();
    loadAllMessages();
}

function scrollToMsg(msgId) {
    const row = document.getElementById(`msg-${msgId}`);
    if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const bubble = row.querySelector('.message-bubble');
        bubble.classList.add('highlighted');
        setTimeout(() => bubble.classList.remove('highlighted'), 1000);
    }
}

function playNotifSound() {
    const audio = document.getElementById('notif-sound');
    if (!audio.src) {
        audio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
    }
    audio.play().catch(e => console.log(e));
}

function openContextMenu(e, msgId) {
    let pageX = e.pageX;
    let pageY = e.pageY;

    if (e.touches && e.touches.length > 0) {
        pageX = e.touches[0].pageX;
        pageY = e.touches[0].pageY;
    }
    if (e.preventDefault) e.preventDefault();
    selectedMsgId = msgId;

    // Position Context Menu
    const menu = document.getElementById('context-menu');
    let topPosition = pageY;
    let leftPosition = pageX;

    // Update 'Pin' wording dynamically
    const allMsgs = getLocalData(MSG_KEY, {});
    const pItem = document.getElementById('menu-pin-item');
    if (pItem) {
        pItem.innerText = (allMsgs[msgId] && allMsgs[msgId].pinned) ? 'Unpin' : 'Pin';
    }

    if (topPosition + 150 > window.innerHeight) {
        topPosition = window.innerHeight - 150;
    }
    if (leftPosition + 150 > window.innerWidth) {
        leftPosition = window.innerWidth - 150;
    }

    menu.style.left = leftPosition + 'px';
    menu.style.top = topPosition + 'px';
    menu.classList.add('active');

    // Position Reaction Popup just above menu
    const rPopup = document.getElementById('reaction-popup');
    rPopup.style.display = 'flex';

    let rTop = topPosition - 60;
    let rLeft = leftPosition - 20;

    if (rTop < 60) rTop = topPosition + 150; // Place below if no space above

    rPopup.style.left = rLeft + 'px';
    rPopup.style.top = rTop + 'px';
    setTimeout(() => rPopup.classList.add('active'), 10);

    // Hide reactions when clicking outside
    const hideReactions = (ev) => {
        if (!ev.target.closest('.reaction-popup')) {
            rPopup.classList.remove('active');
            setTimeout(() => rPopup.style.display = 'none', 200);
            document.removeEventListener('click', hideReactions);
        }
    };
    setTimeout(() => document.addEventListener('click', hideReactions), 10);
}

function addReaction(emoji) {
    if (!selectedMsgId) return;

    const allMsgs = getLocalData(MSG_KEY, {});
    const msg = allMsgs[selectedMsgId];
    if (msg && !msg.deleted) {
        if (!msg.reactions) msg.reactions = [];
        // Optional toggle logic
        const idx = msg.reactions.indexOf(emoji);
        if (idx > -1) msg.reactions.splice(idx, 1);
        else msg.reactions.push(emoji);

        // Max 3 reactions
        if (msg.reactions.length > 3) msg.reactions.shift();

        setLocalData(MSG_KEY, allMsgs);
        syncLocalToFirebase();
        loadAllMessages();
    }

    const rPopup = document.getElementById('reaction-popup');
    rPopup.classList.remove('active');
    setTimeout(() => rPopup.style.display = 'none', 200);
    document.getElementById('context-menu').classList.remove('active');
}

function closeDialog() {
    document.getElementById('dialog-overlay').classList.remove('active');
}

function promptClearChat() {
    document.getElementById('main-menu').classList.remove('active');

    if (confirm("Are you sure you want to permanently delete the chat history? This action cannot be undone.")) {
        clearAllMessages();
    }
}

function promptDeleteForMe() {
    document.getElementById('main-menu').classList.remove('active');

    if (confirm("Delete all messages for you only? The other user will still see them.")) {
        deleteAllForMe();
    }
}

function deleteAllForMe() {
    const allMsgs = getLocalData(MSG_KEY, {});

    for (let id in allMsgs) {
        if (!allMsgs[id].deletedFor) allMsgs[id].deletedFor = [];
        if (!allMsgs[id].deletedFor.includes(currentUser)) {
            allMsgs[id].deletedFor.push(currentUser);
        }
    }

    setLocalData(MSG_KEY, allMsgs);
    messagesList = {};

    // Clear DOM
    const chatBody = document.getElementById('chat-body');
    if (chatBody) {
        chatBody.querySelectorAll('.message-row, .date-badge').forEach(r => r.remove());
    }

    // Sync to Firebase
    syncLocalToFirebase();

    loadAllMessages();
    showToast("Messages deleted for you");
}

function clearAllMessages() {
    clearingChat = true;

    // Remove all messages from local storage
    setLocalData(MSG_KEY, {});
    messagesList = {};

    // Clear DOM completely
    const chatBody = document.getElementById('chat-body');
    if (chatBody) {
        chatBody.querySelectorAll('.message-row, .date-badge').forEach(r => r.remove());
    }

    // Delete from Firebase completely
    messagesRef.remove()
        .then(() => {
            clearingChat = false;
            showToast("Chat cleared from all devices");
        })
        .catch(err => {
            clearingChat = false;
            console.error("Firebase clear failed", err);
            showToast("Chat cleared locally");
        });

    // Reload to show empty state
    loadAllMessages();
}

function promptWallpaper() {
    showToast("Coming soon");
    closeDialog();
}

// Initialize Call
window.onload = initApp;

function toggleSearchInput() {
    const banner = document.getElementById('search-banner');
    document.getElementById('main-menu').classList.remove('active');

    if (banner.style.display === 'none') {
        banner.style.display = 'block';
        document.getElementById('chat-search-input').focus();
    } else {
        banner.style.display = 'none';
        document.getElementById('chat-search-input').value = '';
        handleSearch({ target: { value: '' } });
    }
}

function handleSearch(e) {
    const query = e.target.value.toLowerCase();
    const msgs = document.querySelectorAll('.message-row');
    const allMsgs = getLocalData(MSG_KEY, {});

    let firstMatch = null;

    msgs.forEach(row => {
        const textNode = row.querySelector('.message-text');
        if (!textNode || row.querySelector('.deleted-text')) return;

        const msgIdStr = row.id.replace('msg-', '');
        const msg = allMsgs[msgIdStr];
        if (!msg || msg.deleted || (!msg.text && !msg.image)) return;

        let html = '';
        if (msg.image) html += `<img src="${msg.image}" class="message-image" />`;

        let msgText = msg.text || '';
        let editedMark = msg.edited ? `<span class="message-edited"> (edited)</span>` : '';

        if (msgText && query && msgText.toLowerCase().includes(query)) {
            let escaped = escapeHTML(msgText);
            const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`(${safeQuery})`, 'gi');
            escaped = escaped.replace(regex, `<span class="search-highlight">$1</span>`);
            escaped = escaped.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
            html += escaped + editedMark;
            if (!firstMatch) firstMatch = row;
        } else if (msgText) {
            html += escapeHTML(msgText).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>') + editedMark;
        }

        textNode.innerHTML = html;
    });

    if (firstMatch && query) {
        firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// --- Theme Handling (50 Themes) ---
const themes = [
    { id: 'default', name: 'WhatsApp Classic', header: '#075E54', chatBg: '#ECE5DD', sentBubble: '#DCF8C6', recvBubble: '#FFFFFF', textColor: '#111b21', timeColor: '#667781', isDark: false, accent: '#25D366', preview: '#075E54' },
    { id: 'midnight', name: 'Midnight', header: '#1a1a2e', chatBg: '#0f0f23', sentBubble: '#2d2d5e', recvBubble: '#1a1a3e', textColor: '#e0e0ff', timeColor: '#8888bb', isDark: true, accent: '#6c63ff', preview: '#1a1a2e' },
    { id: 'ocean', name: 'Ocean Breeze', header: '#006994', chatBg: '#e8f4f8', sentBubble: '#b3e5fc', recvBubble: '#ffffff', textColor: '#1a3a4a', timeColor: '#5a8a9a', isDark: false, accent: '#00acc1', preview: '#006994' },
    { id: 'forest', name: 'Emerald Forest', header: '#1b5e20', chatBg: '#e8f5e9', sentBubble: '#c8e6c9', recvBubble: '#ffffff', textColor: '#1b3a1e', timeColor: '#558b55', isDark: false, accent: '#4caf50', preview: '#1b5e20' },
    { id: 'sunset', name: 'Golden Sunset', header: '#e65100', chatBg: '#fff3e0', sentBubble: '#ffe0b2', recvBubble: '#ffffff', textColor: '#3e2723', timeColor: '#8d6e63', isDark: false, accent: '#ff9800', preview: '#e65100' },
    { id: 'lavender', name: 'Lavender Dream', header: '#6a1b9a', chatBg: '#f3e5f5', sentBubble: '#e1bee7', recvBubble: '#ffffff', textColor: '#311b4e', timeColor: '#7e57c2', isDark: false, accent: '#ab47bc', preview: '#6a1b9a' },
    { id: 'cherry', name: 'Cherry Blossom', header: '#c62828', chatBg: '#fce4ec', sentBubble: '#f8bbd0', recvBubble: '#ffffff', textColor: '#3e1a1a', timeColor: '#c48b8b', isDark: false, accent: '#e91e63', preview: '#c62828' },
    { id: 'arctic', name: 'Arctic Frost', header: '#37474f', chatBg: '#eceff1', sentBubble: '#cfd8dc', recvBubble: '#ffffff', textColor: '#263238', timeColor: '#78909c', isDark: false, accent: '#607d8b', preview: '#37474f' },
    { id: 'mocha', name: 'Mocha Latte', header: '#4e342e', chatBg: '#efebe9', sentBubble: '#d7ccc8', recvBubble: '#ffffff', textColor: '#3e2723', timeColor: '#8d6e63', isDark: false, accent: '#795548', preview: '#4e342e' },
    { id: 'neon', name: 'Neon Pulse', header: '#1a0033', chatBg: '#0d001a', sentBubble: '#2a0052', recvBubble: '#1a0033', textColor: '#e0c0ff', timeColor: '#9966cc', isDark: true, accent: '#e040fb', preview: '#1a0033' },
    { id: 'coral', name: 'Coral Reef', header: '#d84315', chatBg: '#fbe9e7', sentBubble: '#ffccbc', recvBubble: '#ffffff', textColor: '#3e201a', timeColor: '#bf7960', isDark: false, accent: '#ff5722', preview: '#d84315' },
    { id: 'slate', name: 'Slate Storm', header: '#2c3e50', chatBg: '#1c2833', sentBubble: '#2c3e50', recvBubble: '#1a252f', textColor: '#d5dbdb', timeColor: '#85929e', isDark: true, accent: '#3498db', preview: '#2c3e50' },
    { id: 'mint', name: 'Mint Fresh', header: '#00695c', chatBg: '#e0f2f1', sentBubble: '#b2dfdb', recvBubble: '#ffffff', textColor: '#1a3b38', timeColor: '#4d8c84', isDark: false, accent: '#26a69a', preview: '#00695c' },
    { id: 'royal', name: 'Royal Purple', header: '#4a148c', chatBg: '#ede7f6', sentBubble: '#d1c4e9', recvBubble: '#ffffff', textColor: '#2a1050', timeColor: '#7e57c2', isDark: false, accent: '#7c4dff', preview: '#4a148c' },
    { id: 'cyberpunk', name: 'Cyberpunk', header: '#0a0a0a', chatBg: '#0d0d0d', sentBubble: '#1a1a1a', recvBubble: '#111111', textColor: '#00ff41', timeColor: '#00cc33', isDark: true, accent: '#00ff41', preview: '#0a0a0a' },
    { id: 'rose', name: 'Rose Gold', header: '#5d4037', chatBg: '#fce4ec', sentBubble: '#f8bbd0', recvBubble: '#fff5f5', textColor: '#3e2723', timeColor: '#a1887f', isDark: false, accent: '#ec407a', preview: '#5d4037' },
    { id: 'sapphire', name: 'Sapphire Night', header: '#0d47a1', chatBg: '#0a1929', sentBubble: '#1a3a6a', recvBubble: '#0f2240', textColor: '#bbdefb', timeColor: '#5c8bc4', isDark: true, accent: '#42a5f5', preview: '#0d47a1' },
    { id: 'olive', name: 'Olive Garden', header: '#558b2f', chatBg: '#f1f8e9', sentBubble: '#dcedc8', recvBubble: '#ffffff', textColor: '#2a3a1a', timeColor: '#7cb342', isDark: false, accent: '#8bc34a', preview: '#558b2f' },
    { id: 'wine', name: 'Wine Cellar', header: '#4a0e23', chatBg: '#1a0a12', sentBubble: '#3d1228', recvBubble: '#2a0e1c', textColor: '#f0c8d8', timeColor: '#c47a99', isDark: true, accent: '#f06292', preview: '#4a0e23' },
    { id: 'teal', name: 'Teal Oasis', header: '#00897b', chatBg: '#e0f7fa', sentBubble: '#b2ebf2', recvBubble: '#ffffff', textColor: '#1a3a38', timeColor: '#4db6ac', isDark: false, accent: '#00bcd4', preview: '#00897b' },
    { id: 'charcoal', name: 'Charcoal Elegance', header: '#212121', chatBg: '#121212', sentBubble: '#2c2c2c', recvBubble: '#1e1e1e', textColor: '#e0e0e0', timeColor: '#9e9e9e', isDark: true, accent: '#ff6f00', preview: '#212121' },
    { id: 'peach', name: 'Peach Sorbet', header: '#bf360c', chatBg: '#fff8e1', sentBubble: '#ffe0b2', recvBubble: '#fffde7', textColor: '#3e2a1a', timeColor: '#a1887f', isDark: false, accent: '#ff8f00', preview: '#bf360c' },
    { id: 'indigo', name: 'Indigo Twilight', header: '#1a237e', chatBg: '#e8eaf6', sentBubble: '#c5cae9', recvBubble: '#ffffff', textColor: '#1a1a4e', timeColor: '#5c6bc0', isDark: false, accent: '#3f51b5', preview: '#1a237e' },
    { id: 'aurora', name: 'Aurora Borealis', header: '#004d40', chatBg: '#0a1a18', sentBubble: '#1a3a35', recvBubble: '#0f2a25', textColor: '#b2dfdb', timeColor: '#4db6ac', isDark: true, accent: '#1de9b6', preview: '#004d40' },
    { id: 'sandstone', name: 'Sandstone', header: '#795548', chatBg: '#faf5f0', sentBubble: '#e8ddd5', recvBubble: '#ffffff', textColor: '#3e2e23', timeColor: '#a1887f', isDark: false, accent: '#8d6e63', preview: '#795548' },
    { id: 'electric', name: 'Electric Blue', header: '#01579b', chatBg: '#e1f5fe', sentBubble: '#b3e5fc', recvBubble: '#ffffff', textColor: '#1a2e40', timeColor: '#4fc3f7', isDark: false, accent: '#03a9f4', preview: '#01579b' },
    { id: 'matcha', name: 'Matcha Green', header: '#33691e', chatBg: '#f5f8f0', sentBubble: '#d5e8c0', recvBubble: '#ffffff', textColor: '#2a3a1a', timeColor: '#689f38', isDark: false, accent: '#7cb342', preview: '#33691e' },
    { id: 'dracula', name: 'Dracula', header: '#282a36', chatBg: '#1e1f29', sentBubble: '#44475a', recvBubble: '#2c2e3e', textColor: '#f8f8f2', timeColor: '#6272a4', isDark: true, accent: '#bd93f9', preview: '#282a36' },
    { id: 'bubblegum', name: 'Bubblegum Pop', header: '#ad1457', chatBg: '#fce4ec', sentBubble: '#f48fb1', recvBubble: '#ffffff', textColor: '#3e1a2a', timeColor: '#c2185b', isDark: false, accent: '#f50057', preview: '#ad1457' },
    { id: 'nordic', name: 'Nordic Ice', header: '#455a64', chatBg: '#f5f7fa', sentBubble: '#cfd8dc', recvBubble: '#ffffff', textColor: '#2c3e50', timeColor: '#78909c', isDark: false, accent: '#546e7a', preview: '#455a64' },
    { id: 'volcano', name: 'Volcanic Ash', header: '#3e2723', chatBg: '#1a1210', sentBubble: '#4e2a20', recvBubble: '#2e1a14', textColor: '#efcfc0', timeColor: '#a1887f', isDark: true, accent: '#ff3d00', preview: '#3e2723' },
    { id: 'sky', name: 'Sky Blue', header: '#1565c0', chatBg: '#e3f2fd', sentBubble: '#90caf9', recvBubble: '#ffffff', textColor: '#1a2e48', timeColor: '#64b5f6', isDark: false, accent: '#2196f3', preview: '#1565c0' },
    { id: 'amethyst', name: 'Amethyst Cave', header: '#311b92', chatBg: '#1a0e3e', sentBubble: '#352065', recvBubble: '#20144a', textColor: '#d1c4e9', timeColor: '#9575cd', isDark: true, accent: '#b388ff', preview: '#311b92' },
    { id: 'honey', name: 'Honey Gold', header: '#f57f17', chatBg: '#fffde7', sentBubble: '#fff9c4', recvBubble: '#ffffff', textColor: '#3e3a1a', timeColor: '#c6a100', isDark: false, accent: '#ffd600', preview: '#f57f17' },
    { id: 'steel', name: 'Steel Grey', header: '#424242', chatBg: '#fafafa', sentBubble: '#e0e0e0', recvBubble: '#ffffff', textColor: '#212121', timeColor: '#9e9e9e', isDark: false, accent: '#757575', preview: '#424242' },
    { id: 'ruby', name: 'Ruby Red', header: '#7f0000', chatBg: '#1a0808', sentBubble: '#4a1515', recvBubble: '#2a0e0e', textColor: '#ffcdd2', timeColor: '#ef9a9a', isDark: true, accent: '#ff1744', preview: '#7f0000' },
    { id: 'aqua', name: 'Aquamarine', header: '#00838f', chatBg: '#e0f7fa', sentBubble: '#80deea', recvBubble: '#ffffff', textColor: '#1a3038', timeColor: '#4dd0e1', isDark: false, accent: '#00e5ff', preview: '#00838f' },
    { id: 'pumpkin', name: 'Pumpkin Spice', header: '#e65100', chatBg: '#1a1008', sentBubble: '#4e2a0a', recvBubble: '#2e1a08', textColor: '#ffe0b2', timeColor: '#ffb74d', isDark: true, accent: '#ff9100', preview: '#e65100' },
    { id: 'grass', name: 'Spring Meadow', header: '#2e7d32', chatBg: '#f1faf2', sentBubble: '#a5d6a7', recvBubble: '#ffffff', textColor: '#1a3a1e', timeColor: '#66bb6a', isDark: false, accent: '#00e676', preview: '#2e7d32' },
    { id: 'marine', name: 'Deep Marine', header: '#01579b', chatBg: '#061622', sentBubble: '#0d2a44', recvBubble: '#081e32', textColor: '#b3e5fc', timeColor: '#4fc3f7', isDark: true, accent: '#0091ea', preview: '#01579b' },
    { id: 'blush', name: 'Blush Pink', header: '#880e4f', chatBg: '#fce4ec', sentBubble: '#f8bbd0', recvBubble: '#fff0f5', textColor: '#3e1a28', timeColor: '#ad1457', isDark: false, accent: '#ff4081', preview: '#880e4f' },
    { id: 'espresso', name: 'Espresso', header: '#3e2723', chatBg: '#f5f0eb', sentBubble: '#d7ccc8', recvBubble: '#ffffff', textColor: '#3e2723', timeColor: '#8d6e63', isDark: false, accent: '#6d4c41', preview: '#3e2723' },
    { id: 'galaxy', name: 'Galaxy Night', header: '#0d0033', chatBg: '#060018', sentBubble: '#1a0044', recvBubble: '#0d0028', textColor: '#d0c0ff', timeColor: '#7c5cbf', isDark: true, accent: '#7c4dff', preview: '#0d0033' },
    { id: 'sage', name: 'Sage Harmony', header: '#4a635a', chatBg: '#f0f4f2', sentBubble: '#c8d8cf', recvBubble: '#ffffff', textColor: '#2a3a30', timeColor: '#6a8a78', isDark: false, accent: '#66bb6a', preview: '#4a635a' },
    { id: 'obsidian', name: 'Obsidian', header: '#1a1a1a', chatBg: '#0a0a0a', sentBubble: '#262626', recvBubble: '#1a1a1a', textColor: '#e8e8e8', timeColor: '#888888', isDark: true, accent: '#ffffff', preview: '#1a1a1a' },
    { id: 'tropical', name: 'Tropical Paradise', header: '#00695c', chatBg: '#e0fff8', sentBubble: '#a7ffeb', recvBubble: '#ffffff', textColor: '#1a3a35', timeColor: '#26a69a', isDark: false, accent: '#1de9b6', preview: '#00695c' },
    { id: 'bordeaux', name: 'Bordeaux', header: '#4a1030', chatBg: '#f8eff4', sentBubble: '#e8c8d8', recvBubble: '#ffffff', textColor: '#3e1a28', timeColor: '#8e4466', isDark: false, accent: '#c2185b', preview: '#4a1030' },
    { id: 'carbon', name: 'Carbon Fiber', header: '#1c1c1c', chatBg: '#141414', sentBubble: '#2a2a2a', recvBubble: '#1e1e1e', textColor: '#d4d4d4', timeColor: '#808080', isDark: true, accent: '#00e5ff', preview: '#1c1c1c' },
    { id: 'sunrise', name: 'Sunrise Glow', header: '#c43e00', chatBg: '#fff8f0', sentBubble: '#ffd6b0', recvBubble: '#ffffff', textColor: '#3e2010', timeColor: '#c48050', isDark: false, accent: '#ff6d00', preview: '#c43e00' },
    { id: 'cosmos', name: 'Cosmic Purple', header: '#1a0a2e', chatBg: '#0f0820', sentBubble: '#2a1548', recvBubble: '#1a0e32', textColor: '#d8c0f0', timeColor: '#9b7ac4', isDark: true, accent: '#ea80fc', preview: '#1a0a2e' },
];

let currentThemeId = localStorage.getItem('wa_theme_id') || 'default';

function openThemePicker() {
    const overlay = document.getElementById('theme-picker-overlay');
    const grid = document.getElementById('theme-grid');
    grid.innerHTML = '';

    themes.forEach(t => {
        const card = document.createElement('div');
        card.className = 'theme-card' + (t.id === currentThemeId ? ' active' : '');
        card.onclick = () => applyThemeById(t.id);
        card.innerHTML = `
            <div class="theme-preview" style="background: ${t.chatBg};">
                <div class="tp-header" style="background: ${t.header};"></div>
                <div class="tp-sent" style="background: ${t.sentBubble};"></div>
                <div class="tp-recv" style="background: ${t.recvBubble};"></div>
            </div>
            <div class="theme-name">${t.name}</div>
        `;
        grid.appendChild(card);
    });

    overlay.classList.add('active');
}

function closeThemePicker(e) {
    document.getElementById('theme-picker-overlay').classList.remove('active');
}

function applyThemeById(id, skipSync) {
    const theme = themes.find(t => t.id === id);
    if (!theme) return;

    currentThemeId = id;
    localStorage.setItem('wa_theme_id', id);

    // Toggle dark class
    document.body.classList.remove('dark-theme');
    if (theme.isDark) document.body.classList.add('dark-theme');

    // Compute derived colors
    const bgLight = theme.isDark ? lighten(theme.chatBg, 8) : darken(theme.chatBg, 5);
    const inputBg = theme.isDark ? lighten(theme.chatBg, 12) : '#ffffff';
    const cardBg = theme.isDark ? lighten(theme.chatBg, 15) : 'rgba(255,255,255,0.75)';
    const borderCol = theme.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const hoverBg = theme.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)';

    // --- CSS Variables ---
    const root = document.documentElement;
    root.style.setProperty('--primary', theme.header);
    root.style.setProperty('--my-msg', theme.sentBubble);
    root.style.setProperty('--other-msg', theme.recvBubble);
    root.style.setProperty('--time-text', theme.timeColor);
    root.style.setProperty('--light-green', theme.accent);
    root.style.setProperty('--accent-border', theme.accent);
    root.style.setProperty('--secondary', theme.accent);
    root.style.setProperty('--sys-msg-bg', theme.isDark ? lighten(theme.chatBg, 10) : 'rgba(254,232,162,0.85)');
    root.style.setProperty('--danger', '#d9534f');

    // --- Body Background ---
    if (theme.isDark) {
        document.body.style.background = darken(theme.chatBg, 15);
    } else {
        document.body.style.background = `linear-gradient(135deg, ${darken(theme.header, 20)} 0%, ${darken(theme.header, 30)} 100%)`;
    }

    // --- App Container ---
    const app = document.getElementById('app');
    if (app) {
        app.style.background = theme.isDark ? lighten(theme.chatBg, 5) : 'rgba(255,255,255,0.12)';
    }

    // --- Landing Page ---
    const landing = document.getElementById('landing-page');
    if (landing) {
        landing.style.background = theme.isDark
            ? `linear-gradient(160deg, ${theme.header}15 0%, ${theme.chatBg} 50%, ${theme.accent}10 100%)`
            : `linear-gradient(160deg, ${theme.accent}15 0%, ${theme.header}08 50%, ${theme.accent}10 100%)`;
    }

    // Glass card
    const glassCard = document.querySelector('.landing-glass-card');
    if (glassCard) {
        glassCard.style.background = cardBg;
        glassCard.style.borderColor = borderCol;
    }

    // Title & subtitle
    document.querySelectorAll('#landing-page h2, .landing-title, .popup-text').forEach(el => {
        el.style.color = theme.textColor;
    });
    document.querySelectorAll('.subtitle, .helper-text').forEach(el => {
        el.style.color = theme.timeColor;
    });

    // Premium buttons
    document.querySelectorAll('.premium-btn').forEach(btn => {
        btn.style.background = theme.isDark
            ? `linear-gradient(135deg, ${lighten(theme.chatBg, 18)} 0%, ${lighten(theme.chatBg, 12)} 100%)`
            : `linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.7) 100%)`;
        btn.style.color = theme.textColor;
        btn.style.borderColor = borderCol;
    });

    // Logo container
    const logo = document.querySelector('.wa-logo-container');
    if (logo) logo.style.background = `linear-gradient(135deg, ${theme.accent} 0%, ${theme.header} 100%)`;

    // --- Header ---
    const header = document.querySelector('header');
    if (header) header.style.background = theme.header;

    // --- Chat Body ---
    const chatBody = document.getElementById('chat-body');
    if (chatBody) {
        chatBody.style.backgroundColor = theme.chatBg;
        chatBody.style.color = theme.textColor;
    }

    // --- Message Bubbles ---
    document.querySelectorAll('.message-row.sent .message-bubble').forEach(b => {
        b.style.background = theme.sentBubble;
    });
    document.querySelectorAll('.message-row.received .message-bubble').forEach(b => {
        b.style.background = theme.recvBubble;
    });
    document.querySelectorAll('.message-text').forEach(el => {
        el.style.color = theme.textColor;
    });
    document.querySelectorAll('.message-time').forEach(el => {
        el.style.color = theme.timeColor;
    });

    // --- Input Area ---
    const inputWrapper = document.querySelector('.input-wrapper');
    if (inputWrapper) {
        inputWrapper.style.background = theme.isDark ? lighten(theme.chatBg, 15) : 'rgba(255,255,255,0.85)';
        inputWrapper.style.borderColor = borderCol;
    }

    const footer = document.querySelector('footer');
    if (footer) footer.style.background = 'transparent';

    const msgInput = document.getElementById('msg-input');
    if (msgInput) {
        msgInput.style.color = theme.textColor;
        msgInput.style.background = 'transparent';
    }

    // Send button
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.style.background = `linear-gradient(135deg, ${theme.accent} 0%, ${theme.header} 100%)`;

    // Icon buttons
    document.querySelectorAll('.icon-btn svg').forEach(svg => {
        svg.style.fill = theme.timeColor;
    });

    // --- Emoji Panel ---
    const emojiPanel = document.getElementById('emoji-panel');
    if (emojiPanel) {
        emojiPanel.style.background = theme.isDark ? lighten(theme.chatBg, 10) : '#f0f2f5';
        emojiPanel.style.borderColor = borderCol;
    }
    const emojiCats = document.querySelector('.emoji-categories');
    if (emojiCats) {
        emojiCats.style.background = theme.isDark ? lighten(theme.chatBg, 8) : '#fff';
        emojiCats.style.borderColor = borderCol;
    }

    // --- Reply Preview ---
    const replyPreview = document.getElementById('reply-preview');
    if (replyPreview) {
        replyPreview.style.background = theme.isDark ? lighten(theme.chatBg, 8) : '#f0f0f0';
        replyPreview.style.borderColor = borderCol;
    }

    // --- Encryption banner ---
    document.querySelectorAll('.encryption-banner, .encryption-notice').forEach(el => {
        el.style.background = theme.isDark ? lighten(theme.chatBg, 10) : 'rgba(254,232,162,0.85)';
        el.style.color = theme.isDark ? theme.timeColor : '#54656f';
    });

    // --- Date badges ---
    document.querySelectorAll('.date-badge').forEach(el => {
        el.style.background = theme.isDark ? lighten(theme.chatBg, 10) : 'rgba(254,232,162,0.85)';
        el.style.color = theme.isDark ? theme.timeColor : '#54656f';
    });

    // --- Dialog ---
    document.querySelectorAll('.dialog').forEach(el => {
        el.style.background = theme.isDark ? lighten(theme.chatBg, 15) : '#fff';
        el.style.color = theme.textColor;
    });
    document.querySelectorAll('.dialog-title, .dialog-option').forEach(el => {
        el.style.color = theme.textColor;
    });
    document.querySelectorAll('.dialog-btn').forEach(el => {
        el.style.color = theme.accent;
    });

    // --- Context menu ---
    const ctxMenu = document.getElementById('context-menu');
    if (ctxMenu) {
        ctxMenu.style.background = theme.isDark ? lighten(theme.chatBg, 15) : '#fff';
    }
    document.querySelectorAll('#context-menu .dropdown-item').forEach(el => {
        el.style.color = theme.textColor;
    });

    // --- Dropdown menu ---
    document.querySelectorAll('.dropdown').forEach(el => {
        el.style.background = theme.isDark ? lighten(theme.chatBg, 15) : '#fff';
    });
    document.querySelectorAll('.dropdown-item').forEach(el => {
        el.style.color = theme.textColor;
    });

    // --- Reaction popup ---
    document.querySelectorAll('.reaction-popup').forEach(el => {
        el.style.background = theme.isDark ? lighten(theme.chatBg, 15) : 'rgba(255,255,255,0.85)';
    });

    // --- Search banner ---
    const searchBanner = document.getElementById('search-banner');
    if (searchBanner) {
        searchBanner.style.background = theme.isDark ? lighten(theme.chatBg, 8) : '#f0f2f5';
        searchBanner.style.borderColor = borderCol;
    }
    const searchInput = document.getElementById('chat-search-input');
    if (searchInput) {
        searchInput.style.color = theme.textColor;
        searchInput.style.background = theme.isDark ? lighten(theme.chatBg, 12) : '#fff';
    }

    // --- Pinned banner ---
    document.querySelectorAll('.pinned-banner').forEach(el => {
        el.style.background = theme.isDark ? lighten(theme.chatBg, 8) : '#f0f7f0';
    });

    // --- Toast ---
    const toast = document.getElementById('toast');
    if (toast) {
        toast.style.background = theme.isDark ? '#e9edef' : 'rgba(0,0,0,0.7)';
        toast.style.color = theme.isDark ? '#111b21' : '#fff';
    }

    // --- Scroll to bottom button ---
    document.querySelectorAll('.scroll-to-bottom').forEach(el => {
        el.style.background = theme.isDark ? lighten(theme.chatBg, 15) : '#fff';
    });

    // --- Theme Picker itself ---
    const panel = document.querySelector('.theme-picker-panel');
    if (panel) {
        panel.style.background = theme.isDark ? lighten(theme.chatBg, 12) : '#fff';
    }
    document.querySelectorAll('.theme-picker-header h3').forEach(el => el.style.color = theme.textColor);
    document.querySelectorAll('.theme-name').forEach(el => el.style.color = theme.textColor);
    document.querySelectorAll('.theme-card').forEach(el => {
        el.style.background = theme.isDark ? lighten(theme.chatBg, 8) : '#f5f5f5';
    });

    // --- Undo toast ---
    document.querySelectorAll('.undo-toast').forEach(el => {
        el.style.background = theme.isDark ? lighten(theme.chatBg, 12) : '#323232';
        el.style.color = theme.isDark ? theme.textColor : '#fff';
    });

    // --- Password card ---
    document.querySelectorAll('.password-card').forEach(el => {
        el.style.background = cardBg;
        el.style.color = theme.textColor;
    });

    // Update picker active state
    document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));

    // Close picker
    closeThemePicker();
    showToast(theme.name + ' applied');

    // Sync theme to Firebase
    if (!skipSync) {
        try {
            db.ref('chat/theme').set(id);
        } catch (e) { }
    }
}

// Helper: lighten a hex color
function lighten(hex, pct) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    let r = parseInt(hex.substr(0, 2), 16);
    let g = parseInt(hex.substr(2, 2), 16);
    let b = parseInt(hex.substr(4, 2), 16);
    r = Math.min(255, r + Math.round((255 - r) * pct / 100));
    g = Math.min(255, g + Math.round((255 - g) * pct / 100));
    b = Math.min(255, b + Math.round((255 - b) * pct / 100));
    return `rgb(${r},${g},${b})`;
}

// Helper: darken a hex color
function darken(hex, pct) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    let r = parseInt(hex.substr(0, 2), 16);
    let g = parseInt(hex.substr(2, 2), 16);
    let b = parseInt(hex.substr(4, 2), 16);
    r = Math.max(0, Math.round(r * (100 - pct) / 100));
    g = Math.max(0, Math.round(g * (100 - pct) / 100));
    b = Math.max(0, Math.round(b * (100 - pct) / 100));
    return `rgb(${r},${g},${b})`;
}

// Apply saved theme on load + listen for Firebase theme changes
function initTheme() {
    const savedId = localStorage.getItem('wa_theme_id');
    if (savedId && themes.find(t => t.id === savedId)) {
        applyThemeById(savedId, true);
    }

    // Listen for theme changes from Firebase (other devices)
    try {
        db.ref('chat/theme').on('value', snap => {
            const remoteTheme = snap.val();
            if (remoteTheme && remoteTheme !== currentThemeId && themes.find(t => t.id === remoteTheme)) {
                currentThemeId = remoteTheme;
                localStorage.setItem('wa_theme_id', remoteTheme);
                applyThemeById(remoteTheme, true);
            }
        });
    } catch (e) { }
}

// Legacy compatibility
function applyTheme(theme) {
    if (theme === 'dark') applyThemeById('midnight');
}

function toggleTheme() {
    openThemePicker();
}

// Init theme
initTheme();

// --- Emoji Picker ---
const emojiData = {
    smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '🥹', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖'],
    animals: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🫎', '🐝', '🪲', '🐛', '🦋', '🐌', '🐞', '🐜', '🪰', '🪱', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🪼', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🪸', '🐊', '🐅', '🐆', '🦓', '🫏', '🦍', '🦧', '🐘', '🦣', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🦬', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🫎', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🪽', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊️', '🐇'],
    food: ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🫛', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🫚', '🥔', '🍠', '🫘', '🌰', '🥜', '🍯', '🥐', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🫗', '☕', '🍵', '🧃', '🥤', '🧋', '🫧', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🍾', '🧊'],
    sports: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🤼', '🏋️', '🤸', '⛹️', '🤺', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚵', '🚴', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎫', '🎟️', '🎪'],
    travel: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🛵', '🏍️', '🛺', '🚲', '🛴', '🛹', '🛼', '🚁', '✈️', '🛩️', '🪂', '🚀', '🛸', '🛶', '⛵', '🚤', '🛳️', '⛴️', '🚢', '⚓', '🗼', '🗽', '🗻', '🏔️', '🌋', '🏕️', '🏖️', '🏜️', '🏝️', '🏞️', '🏟️', '🏛️', '🏗️', '🧱', '🏘️', '🏠', '🏡', '🏢', '🏣', '🏤', '🏥', '🏦', '🏨', '🏩', '🏪', '🏫', '🏬', '🏭', '🏯', '🏰', '💒', '🗾', '🎑', '🏞️', '🌅', '🌄', '🌠', '🎇', '🎆', '🌇', '🌆', '🏙️', '🌃', '🌌', '🌉', '🌁'],
    objects: ['⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️', '🗜️', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽️', '🎞️', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛', '⏳', '📡', '🔋', '🔌', '💡', '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🪛', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🪚', '🔩', '⚙️', '🪤', '🧱', '⛓️', '🧲', '🔫', '💣', '🧨', '🪓', '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️', '🪦', '⚱️', '🏺', '🔮', '📿', '🧿', '🪬', '💈', '⚗️', '🔭', '🔬', '🕳️', '🩹', '🩺', '🩻', '💊', '💉', '🩸', '🧬', '🦠', '🧫', '🧪', '🌡️', '🧹', '🪣', '🧺', '🧻', '🚽', '🪠', '🚿', '🛁', '🪥', '🧼', '🪒', '🧽', '🪣', '🧴', '🛎️', '🔑', '🗝️', '🚪', '🪑', '🛋️', '🛏️', '🛌', '🧸', '🪆', '🖼️', '🪞', '🪟', '🛍️', '🛒', '🎁', '🎈', '🎏', '🎀', '🪄', '🪅', '🎊', '🎉', '🎎', '🏮', '🎐', '🧧', '✉️', '📩', '📨', '📧', '💌', '📥', '📤', '📦', '🏷️', '🪧', '📪', '📫', '📬', '📭', '📮', '📯', '📜', '📃', '📄', '📑', '🧾', '📊', '📈', '📉', '🗒️', '🗓️', '📆', '📅', '🗑️', '📇', '🗃️', '🗳️', '🗄️', '📋', '📁', '📂', '🗂️', '🗞️', '📰', '📓', '📔', '📒', '📕', '📗', '📘', '📙', '📚', '📖', '🔖', '🧷', '🔗', '📎', '🖇️', '📐', '📏', '🧮', '📌', '📍', '✂️', '🖊️', '🖋️', '✒️', '🖌️', '🖍️', '📝', '✏️', '🔍', '🔎', '🔏', '🔐', '🔒', '🔓'],
    symbols: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️', '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️', '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫', '💯', '💢', '♨️', '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗', '❕', '❓', '❔', '‼️', '⁉️', '🔅', '🔆', '〽️', '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️', '✅', '🈯', '💹', '❇️', '✳️', '❎', '🌐', '💠', 'Ⓜ️', '🌀', '💤', '🏧', '🚾', '♿', '🅿️', '🛗', '🈳', '🈂️', '🛂', '🛃', '🛄', '🛅', '🚹', '🚺', '🚼', '⚧️', '🚻', '🚮', '🎦', '📶', '🈁', '🔣', 'ℹ️', '🔤', '🔡', '🔠', '🆖', '🆗', '🆙', '🆒', '🆕', '🆓', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '🔢', '#️⃣', '*️⃣', '⏏️', '▶️', '⏸️', '⏯️', '⏹️', '⏺️', '⏭️', '⏮️', '⏩', '⏪', '⏫', '⏬', '◀️', '🔼', '🔽', '➡️', '⬅️', '⬆️', '⬇️', '↗️', '↘️', '↙️', '↖️', '↕️', '↔️', '↪️', '↩️', '⤴️', '⤵️', '🔀', '🔁', '🔂', '🔄', '🔃', '🎵', '🎶', '➕', '➖', '➗', '✖️', '🟰', '♾️', '💲', '💱', '™️', '©️', '®️', '〰️', '➰', '➿', '🔚', '🔙', '🔛', '🔝', '🔜', '✔️', '☑️', '🔘', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤', '🔺', '🔻', '🔸', '🔹', '🔶', '🔷', '🔳', '🔲', '▪️', '▫️', '◾', '◻️', '◼️', '◽', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬛', '⬜', '🟫', '🔈', '🔇', '🔉', '🔊', '🔔', '🔕', '📣', '📢', '👁️‍🗨️', '💬', '💭', '🗯️', '♠️', '♣️', '♥️', '♦️', '🃏', '🎴', '🀄', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛']
};

function toggleEmojiPanel() {
    const panel = document.getElementById('emoji-panel');
    if (!panel) return;
    if (panel.style.display === 'none' || panel.style.display === '') {
        panel.style.display = 'flex';
        loadEmojis('smileys');
    } else {
        panel.style.display = 'none';
    }
}

function loadEmojis(category) {
    const grid = document.getElementById('emoji-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const emojis = emojiData[category] || emojiData.smileys;
    emojis.forEach(emoji => {
        const span = document.createElement('span');
        span.className = 'emoji-item';
        span.innerText = emoji;
        span.onclick = () => insertEmoji(emoji);
        grid.appendChild(span);
    });

    document.querySelectorAll('.emoji-cat').forEach(cat => {
        cat.classList.remove('active-cat');
        const match = cat.getAttribute('onclick');
        if (match && match.includes(category)) {
            cat.classList.add('active-cat');
        }
    });
}

function insertEmoji(emoji) {
    const msgInput = document.getElementById('msg-input');
    if (!msgInput) return;
    msgInput.value += emoji;
    msgInput.focus();
    handleInput();
}

// --- Profile Settings ---
function startProfileSync() {
    usersRef.on('value', snap => {
        const data = snap.val() || {};
        if (data.user1) usersProfile.user1 = { ...usersProfile.user1, ...data.user1 };
        if (data.user2) usersProfile.user2 = { ...usersProfile.user2, ...data.user2 };
        updateUIWithProfiles();
    });
}

function updateUIWithProfiles() {
    // 1. Landing Page
    const landName1 = document.getElementById('landing-name-user1');
    const landDp1 = document.getElementById('landing-dp-user1');
    const landSvg1 = document.getElementById('landing-svg-user1');
    if (landName1) landName1.innerText = usersProfile.user1.name || 'Anik';
    if (landDp1 && landSvg1) {
        if (usersProfile.user1.dp) {
            landDp1.src = usersProfile.user1.dp;
            landDp1.style.display = 'block';
            landSvg1.style.display = 'none';
        } else {
            landDp1.style.display = 'none';
            landSvg1.style.display = 'block';
        }
    }

    const landName2 = document.getElementById('landing-name-user2');
    const landDp2 = document.getElementById('landing-dp-user2');
    const landSvg2 = document.getElementById('landing-svg-user2');
    if (landName2) landName2.innerText = usersProfile.user2.name || 'BEHULA';
    if (landDp2 && landSvg2) {
        if (usersProfile.user2.dp) {
            landDp2.src = usersProfile.user2.dp;
            landDp2.style.display = 'block';
            landSvg2.style.display = 'none';
        } else {
            landDp2.style.display = 'none';
            landSvg2.style.display = 'block';
        }
    }

    // 2. Chat Header
    if (currentUser && partnerUser) {
        const cName = document.getElementById('chat-partner-name');
        const cDp = document.getElementById('chat-partner-dp');
        const cSvg = document.getElementById('chat-partner-svg');
        if (cName) cName.innerText = usersProfile[partnerUser].name;
        if (cDp && cSvg) {
            if (usersProfile[partnerUser].dp) {
                cDp.src = usersProfile[partnerUser].dp;
                cDp.style.display = 'block';
                cSvg.style.display = 'none';
            } else {
                cDp.style.display = 'none';
                cSvg.style.display = 'block';
            }
        }
    }
}

function openProfileModal() {
    tempProfileDP = usersProfile[currentUser].dp || null;
    const nameInput = document.getElementById('profile-name-input');
    const dpPreview = document.getElementById('profile-dp-preview');
    const dpPlaceholder = document.getElementById('profile-dp-placeholder');

    nameInput.value = usersProfile[currentUser].name;

    if (tempProfileDP) {
        dpPreview.src = tempProfileDP;
        dpPreview.style.display = 'block';
        dpPlaceholder.style.display = 'none';
    } else {
        dpPreview.style.display = 'none';
        dpPlaceholder.style.display = 'flex';
    }

    // Hide main menu dropdown
    const menu = document.getElementById('main-menu');
    if (menu) menu.style.display = 'none';

    document.getElementById('profile-modal').style.display = 'flex';
}

function closeProfileModal() {
    document.getElementById('profile-modal').style.display = 'none';
    tempProfileDP = null;
}

function handleDPSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            const canvas = document.createElement('canvas');
            const maxDim = 150; // Compress avatar significantly
            let width = img.width;
            let height = img.height;

            if (width > height) {
                if (width > maxDim) {
                    height = Math.round(height * (maxDim / width));
                    width = maxDim;
                }
            } else {
                if (height > maxDim) {
                    width = Math.round(width * (maxDim / height));
                    height = maxDim;
                }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            tempProfileDP = canvas.toDataURL('image/jpeg', 0.8);

            const dpPreview = document.getElementById('profile-dp-preview');
            const dpPlaceholder = document.getElementById('profile-dp-placeholder');
            dpPreview.src = tempProfileDP;
            dpPreview.style.display = 'block';
            dpPlaceholder.style.display = 'none';
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function saveProfile() {
    const nameInput = document.getElementById('profile-name-input').value.trim();
    if (!nameInput) {
        showToast('Name cannot be empty');
        return;
    }

    // Optimistic Update
    usersProfile[currentUser].name = nameInput;
    if (tempProfileDP) usersProfile[currentUser].dp = tempProfileDP;
    updateUIWithProfiles();

    // Push to Firebase
    usersRef.child(currentUser).update({
        name: nameInput,
        dp: usersProfile[currentUser].dp
    }).then(() => {
        showToast('Profile updated');
        closeProfileModal();
    }).catch(err => {
        console.error('Failed to update profile', err);
        showToast('Failed to save profile');
    });
}

