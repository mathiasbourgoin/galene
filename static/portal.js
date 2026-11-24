'use strict';

const portalPath = location.pathname.endsWith('/') ? location.pathname : `${location.pathname}/`;
const roomRoot = `${portalPath}group/`;
const apiRoot = `${portalPath}galene-api/v0/`;

function showMessage(id, message, success = false) {
    const el = document.getElementById(id);
    el.textContent = message;
    el.classList.toggle('success', success);
}

function parseRoomInput(raw) {
    let value = raw.trim();
    if (!value)
        throw new Error('Saisissez un lien ou un identifiant de salon.');

    if (value.startsWith('#'))
        value = value.slice(1);

    let target;
    if (/^https?:\/\//i.test(value)) {
        target = new URL(value);
        if (target.origin !== location.origin)
            throw new Error('Ce lien ne mène pas à un salon de ce serveur.');
        if (target.pathname === portalPath && target.hash)
            return parseRoomInput(target.hash);
        if (!target.pathname.startsWith(roomRoot))
            throw new Error('Ce lien ne mène pas à un salon de ce serveur.');
    } else if (value.startsWith(roomRoot)) {
        target = new URL(value, location.origin);
    } else {
        const [room, ...query] = value.split('?');
        const parts = room.split('/').filter(Boolean);
        if (!parts.length || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)))
            throw new Error('Identifiant invalide. Utilisez le lien complet ou un nom de salon.');
        target = new URL(`${roomRoot}${parts.map(encodeURIComponent).join('/')}/`, location.origin);
        if (query.length)
            target.search = query.join('?');
    }

    if (target.username || target.password)
        throw new Error('Le lien ne doit pas contenir d’identifiants.');
    return `${target.pathname}${target.search}`;
}

document.getElementById('join-form').addEventListener('submit', event => {
    event.preventDefault();
    showMessage('join-message', '');
    try {
        location.assign(parseRoomInput(document.getElementById('room-link').value));
    } catch (error) {
        showMessage('join-message', error.message);
    }
});

if (location.hash) {
    document.getElementById('room-link').value = location.hash;
    try {
        location.replace(parseRoomInput(location.hash));
    } catch (error) {
        showMessage('join-message', error.message);
    }
}

async function listPublicGroups() {
    const list = document.getElementById('public-groups');
    try {
        const response = await fetch(`${portalPath}public-groups.json`);
        if (!response.ok)
            throw new Error('Les salons publics ne sont pas disponibles.');
        const groups = await response.json();
        list.replaceChildren();
        if (!groups.length) {
            const empty = document.createElement('p');
            empty.className = 'muted';
            empty.textContent = 'Aucun salon public pour le moment.';
            list.append(empty);
            return;
        }
        for (const group of groups) {
            if (group.redirect || typeof group.location !== 'string')
                continue;
            const link = document.createElement('a');
            link.className = 'public-group';
            const target = new URL(group.location, location.origin);
            if (target.origin !== location.origin)
                continue;
            const targetPath = target.pathname.startsWith('/group/')
                ? `${roomRoot}${target.pathname.slice('/group/'.length)}`
                : target.pathname;
            link.href = `${targetPath}${target.search}`;
            const details = document.createElement('span');
            const title = document.createElement('strong');
            title.textContent = group.displayName || group.name;
            details.append(title);
            if (group.description) {
                const description = document.createElement('small');
                description.textContent = group.description;
                details.append(description);
            }
            const arrow = document.createElement('span');
            arrow.className = 'arrow';
            arrow.setAttribute('aria-hidden', 'true');
            arrow.textContent = '→';
            link.append(details, arrow);
            list.append(link);
        }
        if (!list.childElementCount) {
            const empty = document.createElement('p');
            empty.className = 'muted';
            empty.textContent = 'Aucun salon public pour le moment.';
            list.append(empty);
        }
    } catch (error) {
        list.replaceChildren();
        const message = document.createElement('p');
        message.className = 'muted';
        message.textContent = error.message;
        list.append(message);
    }
}

function setPasswordVisibility() {
    const isPublic = document.querySelector('input[name="access"]:checked').value === 'public';
    document.getElementById('password-field').hidden = isPublic;
    document.getElementById('guest-password').required = !isPublic;
}

document.querySelectorAll('input[name="access"]').forEach(input =>
    input.addEventListener('change', setPasswordVisibility));
setPasswordVisibility();

async function apiRequest(path, options, credentials) {
    const response = await fetch(`${apiRoot}${path}`, {
        ...options,
        headers: {
            ...(options.headers || {}),
            Authorization: `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`
        }
    });
    if (!response.ok) {
        if (response.status === 401 || response.status === 403)
            throw new Error('Identifiants administrateur refusés ou droits de création désactivés.');
        if (response.status === 412 || response.status === 409)
            throw new Error('Ce nom de salon existe déjà. Choisissez-en un autre.');
        throw new Error(`La création a échoué (erreur ${response.status}).`);
    }
    return response;
}

document.getElementById('create-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById('create-button');
    const room = document.getElementById('new-room').value.trim();
    const title = document.getElementById('room-title').value.trim();
    const isPublic = document.querySelector('input[name="access"]:checked').value === 'public';
    const guestPassword = document.getElementById('guest-password').value;
    const credentials = {
        username: document.getElementById('admin-user').value,
        password: document.getElementById('admin-password').value
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/.test(room)) {
        showMessage('create-message', 'Nom invalide. Utilisez 2 à 63 lettres, chiffres, tirets ou soulignés.');
        return;
    }
    if (!credentials.username || !credentials.password) {
        document.querySelector('.admin-details').open = true;
        showMessage('create-message', 'Saisissez les identifiants d’un administrateur Galène.');
        document.getElementById('admin-user').focus();
        return;
    }
    const groupPath = `.groups/${encodeURIComponent(room)}/`;
    showMessage('create-message', 'Création du salon…');
    button.disabled = true;

    try {
        await apiRequest(groupPath, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' },
            body: JSON.stringify({
                public: isPublic,
                'allow-anonymous': isPublic,
                displayName: title || room
            })
        }, credentials);

        try {
            await apiRequest(`${groupPath}.wildcard-user`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ permissions: 'present' })
            }, credentials);
            if (!isPublic) {
                await apiRequest(`${groupPath}.wildcard-user/.password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain' },
                    body: guestPassword
                }, credentials);
            }
        } catch (error) {
            await apiRequest(groupPath, { method: 'DELETE' }, credentials).catch(() => {});
            throw error;
        }

        const joinUrl = `${roomRoot}${encodeURIComponent(room)}/`;
        showMessage('create-message', 'Salon créé. Ouverture de la réunion…', true);
        form.reset();
        document.getElementById('admin-user').value = credentials.username;
        document.getElementById('admin-password').value = '';
        setPasswordVisibility();
        setTimeout(() => location.assign(joinUrl), 500);
    } catch (error) {
        showMessage('create-message', error.message);
    } finally {
        button.disabled = false;
        credentials.password = '';
        document.getElementById('admin-password').value = '';
    }
});

listPublicGroups();
