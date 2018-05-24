import * as vscode from 'vscode';

import { cljConnection } from './cljConnection';
import { cljParser } from './cljParser';
import { nreplClient } from './nreplClient';

function slashEscape(contents: string) {
    return contents
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');
}

function slashUnescape(contents: string) {
    const replacements : { [key: string]: string} = { '\\\\': '\\', '\\n': '\n', '\\"': '"' };
    return contents.replace(/\\(\\|n|")/g, function(match) {
        return replacements[match]
    });
}

const parseReplOutput = (value: any[]): string => {
    if ('ex' in value[0]) {
        vscode.window.showErrorMessage(value[1].err);
        throw value[1].err;
    };
    if (('value' in value[1]) && (value[1].value != 'nil')) {
        let new_content: string = value[1].value.slice(1, -1);
        new_content = slashUnescape(new_content);
        return new_content;
    };

    throw 'Unknown error';
}

const replEvaluate = async (command: string): Promise<string> => {
    return parseReplOutput(await nreplClient.evaluate(command));
}

const formatCljfmt = (
    textEditor: vscode.TextEditor,
    contents: string
): Promise<string> => {
    let cljfmtParams = vscode.workspace.getConfiguration('clojureVSCode').cljfmtParameters;
    cljfmtParams = cljfmtParams.isEmpty ? "nil" : "{"+cljfmtParams+"}";

    // Running "(require 'cljfmt.core)" in right after we have checked we are connected to nREPL
    // would be a better option but in this case "cljfmt.core/reformat-string" fails the first
    // time it is called. I have no idea what causes this behavior so I decided to put the require
    // statement right here - don't think it does any harm. If someone knows how to fix it
    // please send a pull request with a fix.
    return replEvaluate(`(require 'cljfmt.core) (cljfmt.core/reformat-string "${contents}" ${cljfmtParams})`);
}

const formatAll = async (textEditor: vscode.TextEditor, selection: vscode.Selection): Promise<string> => {
    let contents: string = selection.isEmpty ? textEditor.document.getText() : textEditor.document.getText(selection);

    // Escaping the string before sending it to nREPL
    contents = slashEscape(contents);

    contents = await formatCljfmt(textEditor, contents);

    return contents;
}

const getTextEditorSelection = (textEditor: vscode.TextEditor): vscode.Selection => {
    let selection = textEditor.selection;
    if (textEditor.selection.isEmpty) {
        const lines: string[] = textEditor.document.getText().split(/\r?\n/g);
        const lastChar: number = lines[lines.length - 1].length;
        selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(textEditor.document.lineCount, lastChar));
    }

    return selection;
}

export const formatFile = (textEditor: vscode.TextEditor, edit?: vscode.TextEditorEdit): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
        if (!cljConnection.isConnected()) {
            const error = "Formatting functions don't work, connect to nREPL first.";
            vscode.window.showErrorMessage(error);
            reject(error);
            return;
        }

        const selection = getTextEditorSelection(textEditor);
        formatAll(textEditor, selection).then(new_content => {
            textEditor.edit(editBuilder => {
                editBuilder.replace(selection, new_content);
                resolve();
            });
        }, reject);
    });
}

export const maybeActivateFormatOnSave = () => {
    vscode.workspace.onWillSaveTextDocument(e => {
        const document = e.document;
        if (document.languageId !== "clojure") {
            return;
        }
        let textEditor = vscode.window.activeTextEditor;
        if (!textEditor) {
            return
        }
        let editorConfig = vscode.workspace.getConfiguration('editor');
        const globalEditorFormatOnSave = editorConfig && editorConfig.has('formatOnSave') && editorConfig.get('formatOnSave') === true;
        let clojureConfig = vscode.workspace.getConfiguration('clojureVSCode');
        if ((clojureConfig.formatOnSave || globalEditorFormatOnSave) && textEditor.document === document) {
            e.waitUntil(formatFile(textEditor, undefined));
        }
    });
}
