import * as vscode from 'vscode';
import * as net from 'net';

import * as bencodeUtil from './bencodeUtil';
import { cljConnection, CljConnectionInformation } from './cljConnection';

interface nREPLCompleteMessage {
    op: string;
    symbol: string;
    ns?: string
}

interface nREPLInfoMessage {
    op: string;
    symbol: string;
    ns: string;
    session?: string;
}

interface nREPLEvalMessage {
    op: string;
    file: string;
    'file-path'?: string;
    session: string;
}

interface nREPLSingleEvalMessage {
    op: string;
    code: string;
    session: string;
}

interface nREPLStacktraceMessage {
    op: string;
    session: string;
}

interface nREPLCloneMessage {
    op: string;
    session?: string;
}

interface nREPLCloseMessage {
    op: string;
    session?: string;
}

const DONE = 'doneee';

const complete = (symbol: string, ns: string): Promise<any> => {
    const msg: nREPLCompleteMessage = { op: 'complete', symbol, ns };
    return send(msg).then(respObjs => respObjs[0]);
};

const info = (symbol: string, ns: string, session?: string): Promise<any> => {
    const msg: nREPLInfoMessage = { op: 'info', symbol, ns, session };
    return send(msg).then(respObjs => respObjs[0]);
};

const evaluate = (code: string, session?: string): Promise<any[]> => clone(session).then((session_id) => {
    const msg: nREPLSingleEvalMessage = { op: 'eval', code: code, session: session_id };
    return send(msg, undefined, true);
});

const evaluateFile = (code: string, filepath: string, session?: string): Promise<any[]> => clone(session).then((session_id) => {
    const msg: nREPLEvalMessage = { op: 'load-file', file: code, 'file-path': filepath, session: session_id };
    return send(msg);
});

const stacktrace = (session: string): Promise<any> => send({ op: 'stacktrace', session: session });

const clone = (session?: string): Promise<string> => {
    return send({ op: 'clone', session: session }).then(respObjs => respObjs[0]['new-session']);
}

const test = (connectionInfo: CljConnectionInformation): Promise<any[]> => {
    return send({ op: 'clone' }, connectionInfo)
        .then(respObjs => respObjs[0])
        .then(response => {
            if (!('new-session' in response))
                return Promise.reject(false);
            else {
                return Promise.resolve([]);
            }
        });
};

const close = (session?: string): Promise<any[]> => send({ op: 'close', session: session });

const listSessions = (): Promise<[string]> => {
    return send({op: 'ls-sessions'}).then(respObjs => {
        const response = respObjs[0];
        if (response.status[0] == "done") {
            return Promise.resolve(response.sessions);
        }
    });
}

const send = (
    msg: nREPLCompleteMessage | nREPLInfoMessage | nREPLEvalMessage | nREPLStacktraceMessage | nREPLCloneMessage | nREPLCloseMessage | nREPLSingleEvalMessage,
    connection?: CljConnectionInformation,
    expectValue?: boolean
): Promise<any[]> => {
    return new Promise<any[]>((resolve, reject) => {
        connection = connection || cljConnection.getConnection();

        if (!connection)
            return reject('No connection found.');

        const client = net.createConnection(connection.port, connection.host);

        client.on('error', error => {
            client.end();
            client.removeAllListeners();
            if ((error as any)['code'] === 'ECONNREFUSED') {
                vscode.window.showErrorMessage('Connection refused.');
                cljConnection.disconnect();
            }
            reject(error);
        });

        let nreplResp = '';
        let hasValue = false;
        client.on('data', data => {
            const s = data.toString();
            nreplResp += s;

            const lastIndex = data.lastIndexOf(DONE);
            if (lastIndex > -1) {
                const endIndex = nreplResp.length + lastIndex + DONE.length - s.length;
                const relevant = nreplResp.substring(0, endIndex);
                const { decodedObjects } = bencodeUtil.decodeString(relevant);
                hasValue = decodedObjects.find(o => o.value && o.value !== 'nil' || o.out || o.err) !== undefined;

                if (hasValue || !expectValue) {
                    client.end();
                    client.removeAllListeners();
                    resolve(decodedObjects);
                } else {
                    const remaining = nreplResp.substring(endIndex + 1, nreplResp.length);
                    nreplResp = remaining || '';
                }
            }
        });

        Object.keys(msg).forEach(key => (msg as any)[key] === undefined && delete (msg as any)[key]);
        client.write(bencodeUtil.encode(msg), 'binary');
    });
};

export const nreplClient = {
    complete,
    info,
    evaluate,
    evaluateFile,
    stacktrace,
    clone,
    test,
    close,
    listSessions
};
