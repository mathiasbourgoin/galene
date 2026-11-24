'use strict';

/** @typedef {{id?:number, mode:string, color:string, points:number[][]}} BoardStroke */
const sharedCanvas = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (document.getElementById('shared-canvas')));
const boardStrokes = document.getElementById('board-strokes');
let boardVersion = -1;
let boardWantedVersion = -1;
let boardAwaitingState = false;
/** @type {{id:number, stroke:BoardStroke, mark:SVGElement}|null} */
let boardDraft = null;

function updateBoardPermission() {
    const role = serverConnection?.permissions || [];
    const writable = role.includes('message') || role.includes('op');
    getSelectElement('board-mode').disabled = !writable;
    getSelectElement('board-color').disabled = !writable;
    getButtonElement('board-undo').disabled = !writable;
    getButtonElement('board-erase').hidden = !role.includes('op');
    sharedCanvas.toggleAttribute('data-editable', writable);
}

function requestBoard() {
    if(!serverConnection?.group || boardAwaitingState)
        return;
    boardAwaitingState = true;
    serverConnection.groupAction('board/state');
}

function resetBoard() {
    boardDraft?.mark.remove();
    boardDraft = null;
    boardAwaitingState = false;
    boardVersion = -1;
    boardWantedVersion = -1;
    boardStrokes.replaceChildren();
    document.getElementById('board-feedback').textContent = '';
}

/**
 * @param {BoardStroke} stroke
 * @param {SVGElement} [mark]
 */
function boardShape(stroke, mark) {
    const [x0, y0] = stroke.points[0];
    const [x1, y1] = stroke.points[stroke.points.length - 1];
    const namespace = 'http://www.w3.org/2000/svg';
    if(!mark)
        mark = document.createElementNS(namespace, stroke.mode === 'box' ? 'rect' : 'path');
    mark.setAttribute('stroke', stroke.color);
    mark.setAttribute('stroke-width', '32');
    mark.setAttribute('stroke-linecap', 'round');
    mark.setAttribute('stroke-linejoin', 'round');
    mark.setAttribute('fill', 'none');
    if(stroke.mode === 'box') {
        mark.setAttribute('x', String(Math.min(x0, x1)));
        mark.setAttribute('y', String(Math.min(y0, y1)));
        mark.setAttribute('width', String(Math.abs(x1 - x0)));
        mark.setAttribute('height', String(Math.abs(y1 - y0)));
    } else if(stroke.mode === 'arrow') {
        const angle = Math.atan2(y1 - y0, x1 - x0);
        const arm = Math.min(220, Math.hypot(y1 - y0, x1 - x0) / 3);
        const tip = direction => (x1 - arm * Math.cos(angle + direction)) + ' ' +
            (y1 - arm * Math.sin(angle + direction));
        mark.setAttribute('d', `M ${x0} ${y0} L ${x1} ${y1} M ${tip(.56)} L ${x1} ${y1} L ${tip(-.56)}`);
    } else {
        mark.setAttribute('d', 'M ' + stroke.points.map(point => point.join(' ')).join(' L '));
    }
    if(stroke.id)
        mark.setAttribute('data-stroke', String(stroke.id));
    return mark;
}

/** @param {{version:number, strokes:BoardStroke[]|null}} state */
function receiveBoardState(state) {
    boardAwaitingState = false;
    if(state.version < boardVersion)
        return;
    boardVersion = state.version;
    boardStrokes.replaceChildren(...(state.strokes || []).map(stroke => boardShape(stroke)));
    if(state.version < boardWantedVersion && !boardStage.hidden)
        requestBoard();
}

/** @param {{version:number, stroke?:BoardStroke, remove?:number, clear?:boolean}} change */
function receiveBoardChange(change) {
    if(boardStage.hidden || change.version <= boardVersion)
        return;
    boardWantedVersion = Math.max(boardWantedVersion, change.version);
    if(boardVersion < 0 || change.version !== boardVersion + 1) {
        requestBoard();
        return;
    }
    boardVersion = change.version;
    if(change.clear)
        boardStrokes.replaceChildren();
    else if(change.remove)
        boardStrokes.querySelector('[data-stroke="' + change.remove + '"]')?.remove();
    else if(change.stroke)
        boardStrokes.appendChild(boardShape(change.stroke));
    document.getElementById('board-feedback').textContent = '';
}

/** @param {PointerEvent} event */
function boardPoint(event) {
    const matrix = sharedCanvas.getScreenCTM();
    if(!matrix)
        return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return [Math.round(Math.min(10000, Math.max(0, point.x))),
        Math.round(Math.min(6250, Math.max(0, point.y)))];
}

function initializeSharedBoard() {
    sharedCanvas.addEventListener('pointerdown', event => {
        if(!sharedCanvas.hasAttribute('data-editable') || event.button !== 0 || boardDraft)
            return;
        const point = boardPoint(event);
        if(!point)
            return;
        sharedCanvas.setPointerCapture(event.pointerId);
        const stroke = {mode: getSelectElement('board-mode').value,
                        color: getSelectElement('board-color').value, points: [point]};
        const mark = boardShape(stroke);
        mark.setAttribute('data-preview', '');
        sharedCanvas.appendChild(mark);
        boardDraft = {id: event.pointerId, stroke, mark};
    });
    sharedCanvas.addEventListener('pointermove', event => {
        const draft = boardDraft;
        if(!draft || draft.id !== event.pointerId)
            return;
        const point = boardPoint(event);
        if(!point)
            return;
        const points = draft.stroke.points;
        const previous = points[points.length - 1];
        if(Math.hypot(point[0]-previous[0], point[1]-previous[1]) < 12)
            return;
        if(draft.stroke.mode !== 'pen')
            points.length = 1;
        else if(points.length === 90)
            points.pop();
        points.push(point);
        boardShape(draft.stroke, draft.mark);
    });
    sharedCanvas.addEventListener('pointerup', event => {
        const draft = boardDraft;
        if(!draft || draft.id !== event.pointerId)
            return;
        boardDraft = null;
        draft.mark.remove();
        if(draft.stroke.points.length >= 2)
            serverConnection.groupAction('board/draw', draft.stroke);
    });
    sharedCanvas.addEventListener('lostpointercapture', event => {
        if(boardDraft?.id === event.pointerId) {
            boardDraft.mark.remove();
            boardDraft = null;
        }
    });
    getButtonElement('board-undo').onclick = () => serverConnection.groupAction('board/undo');
    getButtonElement('board-erase').onclick = () => {
        if(confirm('Effacer le dessin de tous les participants ?'))
            serverConnection.groupAction('board/clear');
    };
    getButtonElement('download-board').onclick = () => {
        const image = /** @type {SVGSVGElement} */ (sharedCanvas.cloneNode(true));
        image.querySelector('[data-preview]')?.remove();
        image.setAttribute('width', '1600');
        image.setAttribute('height', '1000');
        const contents = new XMLSerializer().serializeToString(image);
        const url = URL.createObjectURL(new Blob([contents], {type:'image/svg+xml'}));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'tableau.svg';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
}
