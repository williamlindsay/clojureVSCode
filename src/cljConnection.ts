import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { nreplClient } from './nreplClient';
import { nreplController } from './nreplController';

export interface CljConnectionInformation {
    host: string;
    port: number;
}

const CONNECTION_STATE_KEY: string = 'CLJ_CONNECTION';
const DEFAULT_LOCAL_IP: string = '127.0.0.1';
const connectionIndicator: vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

let cljContext: vscode.ExtensionContext;

const setCljContext = (context: vscode.ExtensionContext) => cljContext = context;

const getConnection = (): CljConnectionInformation => cljContext.workspaceState.get(CONNECTION_STATE_KEY);

const isConnected = (): boolean => !!getConnection();

const saveConnection = (connection: CljConnectionInformation): void => {
    cljContext.workspaceState.update(CONNECTION_STATE_KEY, connection);

    connectionIndicator.text = `⚡nrepl://${connection.host}:${connection.port}`;
    connectionIndicator.show();

    vscode.window.showInformationMessage('Connected to nREPL.');
};

const saveDisconnection = (showMessage: boolean = true): void => {
    cljContext.workspaceState.update(CONNECTION_STATE_KEY, undefined);

    connectionIndicator.text = '';
    connectionIndicator.show();

    if (showMessage)
        vscode.window.showInformationMessage('Disconnected from nREPL.');
};

let loadingHandler: NodeJS.Timer;
const startLoadingAnimation = () => {
    if (loadingHandler)
        return;

    const maxAnimationDots: number = 10;
    let animationTime: number = 0;

    loadingHandler = setInterval(() => {
        connectionIndicator.text = '⚡Starting nREPL' + '.'.repeat(animationTime);
        connectionIndicator.show();

        animationTime += animationTime < maxAnimationDots ? 1 : -maxAnimationDots;
    }, 500);
};

const stopLoadingAnimation = () => {
    if (loadingHandler) {
        clearInterval(loadingHandler);
        loadingHandler = null;
        connectionIndicator.text = '';
        connectionIndicator.show();
    }
};

const manuallyConnect = (): void => {
    if (loadingHandler) {
        vscode.window.showWarningMessage('Already starting a nREPL. Disconnect first.');
        return;
    }
    if (isConnected()) {
        vscode.window.showWarningMessage('Already connected to nREPL. Disconnect first.');
        return;
    }

    let host: string;
    let port: number;
    vscode.window.showInputBox({ prompt: 'nREPL host', value: DEFAULT_LOCAL_IP })
        .then(hostFromUser => {
            if (!hostFromUser)
                return Promise.reject({ connectionError: 'Host must be informed.' });

            host = hostFromUser;

            const portNumberPromptOptions: vscode.InputBoxOptions = { prompt: 'nREPL port number' };

            if (hostFromUser === DEFAULT_LOCAL_IP || hostFromUser.toLowerCase() === 'localhost') {
                const localPort = getLocalNReplPort();
                if (localPort)
                    portNumberPromptOptions.value = String(localPort);
            }

            return <PromiseLike<string>>vscode.window.showInputBox(portNumberPromptOptions); // cast needed to chain promises
        })
        .then(portFromUser => {
            if (!portFromUser)
                return Promise.reject({ connectionError: 'Port number must be informed.' });

            const intPort = Number.parseInt(portFromUser);
            if (!intPort)
                return Promise.reject({ connectionError: 'Port number must be an integer.' });

            port = intPort;
        })
        .then(() => nreplClient.test({ host, port }))
        .then(() => {
            saveConnection({ host, port });
        }
        , ({ connectionError }) => {
            if (!connectionError)
                connectionError = "Can't connect to the nREPL.";

            vscode.window.showErrorMessage(connectionError);
        });
};

const startNRepl = (): void => {
    if (isConnected()) {
        vscode.window.showWarningMessage('Already connected to nREPL. Disconnect first.');
        return;
    }

    startLoadingAnimation();

    let nreplConnection: CljConnectionInformation;
    nreplController.start()
        .then(connectionInfo => nreplConnection = connectionInfo)
        .then(() => nreplClient.test(nreplConnection))
        .then(stopLoadingAnimation)
        .then(() => saveConnection(nreplConnection))
        .catch(({ nreplError }) => {
            stopLoadingAnimation();
            if (!nreplError)
                nreplError = "Can't start nREPL.";

            disconnect(false);
            vscode.window.showErrorMessage(nreplError);
        });
};

const disconnect = (showMessage: boolean = true): void => {
    if (isConnected() || loadingHandler) {
        stopLoadingAnimation();
        nreplController.stop();
        saveDisconnection(showMessage);
    } else if (showMessage)
        vscode.window.showWarningMessage('Not connected to any nREPL.');
};

const getLocalNReplPort = (): number => {
    const projectDir = vscode.workspace.rootPath;

    if (projectDir) {
        const projectPort: number = getPortFromFS(path.join(projectDir, '.nrepl-port'));
        if (projectPort)
            return projectPort;
    }

    const homeDir = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
    return getPortFromFS(path.join(homeDir, '.lein', 'repl-port'));
};

const getPortFromFS = (path: string): number => fs.existsSync(path) ? Number.parseInt(fs.readFileSync(path, 'utf-8')) : NaN;

export const cljConnection = {
    setCljContext,
    getConnection,
    isConnected,
    manuallyConnect,
    startNRepl,
    disconnect,
};