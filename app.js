// --- Globals & State ---
let currentUser = null;
let partnerUser = null;
let isEditing = false;
let replyToMsgId = null;
let selectedMsgId = null;
let typingTimeout = null;
let messagesList = {};

// --- Local Storage Helpers ---
const MSG_KEY = 'wa_clone_messages';
const PRESENCE_KEY = 'wa_clone_presence';
const TYPING_KEY = 'wa_clone_typing';

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

// --- Sync Operations ---
function startAutoSync() {
    messagesRef.on('value', snap => {
        const remoteData = snap.val() || {};
        const localData = getLocalData(MSG_KEY, {});

        let merged = { ...localData };
        let changed = false;

        for (const key in remoteData) {
            const rMsg = remoteData[key];
            if (!localData[key]) {
                merged[key] = rMsg;
                changed = true;
            } else {
                let lMsg = localData[key];
                if (rMsg.status !== lMsg.status) {
                    lMsg.status = rMsg.status;
                    changed = true;
                }
                if (rMsg.deleted && !lMsg.deleted) {
                    lMsg.deleted = true;
                    changed = true;
                }
                if (rMsg.deletedFor) {
                    if (!lMsg.deletedFor) lMsg.deletedFor = [];
                    for (let d of rMsg.deletedFor) {
                        if (!lMsg.deletedFor.includes(d)) {
                            lMsg.deletedFor.push(d);
                            changed = true;
                        }
                    }
                }
                merged[key] = lMsg;
            }
        }

        if (changed) {
            setLocalData(MSG_KEY, merged);
            loadAllMessages();
        }
    });
}

function syncLocalToFirebase() {
    const localData = getLocalData(MSG_KEY, {});
    messagesRef.update(localData).catch(err => console.error("Sync push failed", err));
}

// --- UI Operations ---
function initApp() {
    const savedUser = localStorage.getItem('chatUser');
    if (savedUser) {
        selectUser(savedUser);
    }
    loadEmojis('smileys');

    // Cross-tab synchronization
    window.addEventListener('storage', handleStorageChange);

    // Periodically cleanup stale typing statuses
    setInterval(cleanupTyping, 3000);

    startAutoSync();
}

function selectUser(userId) {
    currentUser = userId;
    partnerUser = userId === 'user1' ? 'user2' : 'user1';
    localStorage.setItem('chatUser', userId);

    document.getElementById('landing-page').style.display = 'none';
    document.getElementById('chat-page').style.display = 'flex';
    document.getElementById('chat-partner-name').innerText = partnerUser === 'user1' ? 'User 1' : 'User 2';

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

        // Skip rendering if deleted for me
        if (msg.deletedFor && msg.deletedFor.includes(currentUser)) continue;

        if (!messagesList[msgId]) {
            // New message
            addMessageToDOM(msgId, msg);
            needsScroll = true;

            if (msg.sender === partnerUser && msg.status !== 'read') {
                msg.status = 'read';
                markRead = true;
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
        syncLocalToFirebase(); // Sync read status back
    }
    if (needsScroll) {
        setTimeout(scrollToBottom, 50);
    }
}

function renderPresence() {
    if (!partnerUser) return;
    const p = getLocalData(PRESENCE_KEY, {});
    const data = p[partnerUser];
    const statusEl = document.getElementById('chat-partner-status');

    const t = getLocalData(TYPING_KEY, {});
    if (t[partnerUser] && Date.now() - t[partnerUser] < 3000) return; // don't override typing

    if (data && data.online) {
        statusEl.innerText = 'Online';
        statusEl.style.color = 'rgba(255,255,255,0.8)';
        markMessagesAsRead();
    } else if (data && data.lastSeen) {
        statusEl.innerText = `Last seen: ${formatTime(data.lastSeen)}`;
        statusEl.style.color = 'rgba(255,255,255,0.8)';
    } else {
        statusEl.innerText = 'Waiting...';
    }
}

function renderTyping(typingTimestamp) {
    if (!partnerUser) return;
    const isTyping = typingTimestamp && (Date.now() - typingTimestamp < 3000);
    const statusEl = document.getElementById('chat-partner-status');
    const typingIndicator = document.getElementById('typing-indicator');

    if (isTyping) {
        statusEl.innerText = 'typing...';
        statusEl.classList.add('status-typing');
        typingIndicator.classList.add('active');
        scrollToBottom();
    } else {
        statusEl.classList.remove('status-typing');
        typingIndicator.classList.remove('active');
        renderPresence();
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

function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

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

    syncLocalToFirebase();
    loadAllMessages();

    input.value = '';
    input.style.height = 'auto';
    handleInput();
    cancelReply();
    scrollToBottom();

    updateTyping(false);
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
        const senderName = quoted.sender === currentUser ? 'You' : (partnerUser === 'user1' ? 'User 1' : 'User 2');
        replyHTML = `
            <div class="quoted-msg" onclick="scrollToMsg('${msg.replyTo}')">
                <div class="quoted-sender">${senderName}</div>
                <div class="quoted-text">${quoted.deleted ? '🚫 This message was deleted' : escapeHTML(quoted.text)}</div>
            </div>
        `;
    }

    let textContent = escapeHTML(msg.text).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
    if (msg.deleted) {
        textContent = `<span class="deleted-text">🚫 This message was deleted</span>`;
    }

    row.innerHTML = `
        <div class="message-bubble" oncontextmenu="openContextMenu(event, '${msgId}')" ontouchstart="handleTouchStart(event, '${msgId}')" ontouchend="handleTouchEnd(event)">
            ${replyHTML}
            <div class="message-text">${textContent}</div>
            <div class="message-meta">
                <span class="message-time">${formatTime(msg.timestamp || Date.now())}</span>
                ${tickHTML}
            </div>
        </div>
    `;
}

function scrollToBottom() {
    const body = document.getElementById('chat-body');
    body.scrollTop = body.scrollHeight;
    document.getElementById('scroll-bottom').classList.remove('visible');
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
    smileys: ['😀', '😂', '😊', '😍', '😘', '😎', '😭', '😡', '🤔', '😴', '😇', '🥳'],
    animals: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮'],
    food: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍈', '🍒', '🍑'],
    sports: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓'],
    travel: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🚚', '🚛'],
    objects: ['💡', '🔦', '🏮', '📔', '📕', '📖', '📗', '📘', '📙', '📚', '📓', '📒'],
    symbols: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕']
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

    if (msg.deleted) {
        const textDiv = row.querySelector('.message-text');
        if (textDiv) textDiv.innerHTML = `<span class="deleted-text">🚫 This message was deleted</span>`;
        const quotedDiv = row.querySelector('.quoted-msg');
        if (quotedDiv) quotedDiv.remove();
    }
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
    document.getElementById('reply-name').innerText = msg.sender === currentUser ? 'You' : (partnerUser === 'user1' ? 'User 1' : 'User 2');
    document.getElementById('reply-text').innerText = msg.text;
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

    const allMsgs = getLocalData(MSG_KEY, {});

    if (type === 'forEveryone') {
        if (allMsgs[selectedMsgId]) {
            allMsgs[selectedMsgId].deleted = true;
            allMsgs[selectedMsgId].text = '';
            setLocalData(MSG_KEY, allMsgs);
            syncLocalToFirebase();
            loadAllMessages();
        }
    } else if (type === 'forMe') {
        if (allMsgs[selectedMsgId]) {
            if (!allMsgs[selectedMsgId].deletedFor) allMsgs[selectedMsgId].deletedFor = [];
            allMsgs[selectedMsgId].deletedFor.push(currentUser);
            setLocalData(MSG_KEY, allMsgs);
            syncLocalToFirebase();
            loadAllMessages();
        }
    }
    closeDialog();
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
    const menu = document.getElementById('context-menu');

    let topPosition = pageY;
    let leftPosition = pageX;

    if (topPosition + 150 > window.innerHeight) {
        topPosition = window.innerHeight - 150;
    }
    if (leftPosition + 150 > window.innerWidth) {
        leftPosition = window.innerWidth - 150;
    }

    menu.style.left = leftPosition + 'px';
    menu.style.top = topPosition + 'px';
    menu.classList.add('active');
}

function closeDialog() {
    document.getElementById('dialog-overlay').classList.remove('active');
}

function promptClearChat() {
    document.getElementById('main-menu').classList.remove('active');
    document.getElementById('dialog-overlay').classList.add('active');
    document.getElementById('dialog-title').innerText = "Clear this chat?";
    document.getElementById('dialog-body').innerHTML = `<div style="color:#54656f; font-size:14px; margin-bottom:15px;">Are you sure you want to clear messages in this chat?</div><div class="dialog-option danger" onclick="clearAllMessages()">Clear chat</div>`;
}

function clearAllMessages() {
    const allMsgs = getLocalData(MSG_KEY, {});
    for (let id in allMsgs) {
        if (!allMsgs[id].deletedFor) allMsgs[id].deletedFor = [];
        if (!allMsgs[id].deletedFor.includes(currentUser)) {
            allMsgs[id].deletedFor.push(currentUser);
        }
    }
    setLocalData(MSG_KEY, allMsgs);
    syncLocalToFirebase();
    loadAllMessages();
    showToast("Chat cleared");
    closeDialog();
}

function promptWallpaper() {
    showToast("Coming soon");
    closeDialog();
}

// Initialize Call
window.onload = initApp;
