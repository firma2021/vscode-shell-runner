import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const stat = promisify(fs.stat);
const chmod = promisify(fs.chmod);

interface ScriptArgs
{
    [filePath: string]: {
        args: string;
        lastUsed: number; // 时间戳
    };
}

class ShellRunner
{
    private terminal: vscode.Terminal | undefined;
    private readonly terminalName = 'Shell Runner';

    private savedArgs: ScriptArgs = {};
    static readonly max_saved_args = 6;

    private useSudo: boolean = false;

    private clearTerminal: boolean = true;

    constructor(private context: vscode.ExtensionContext)
    {
        this.savedArgs = context.globalState.get('shell-runner.savedArgs', {});
        this.useSudo = context.globalState.get('shell-runner.sudoMode', false);
        this.clearTerminal = context.globalState.get('shell-runner.clearMode', true);

        context.subscriptions.push(
            vscode.window.onDidCloseTerminal((closedTerminal) =>
            {
                if (closedTerminal === this.terminal)
                {
                    this.terminal = undefined;
                }
            })
        );
    }

    toggleSudoMode()
    {
        this.useSudo = !this.useSudo;
        this.context.globalState.update('shell-runner.sudoMode', this.useSudo);

        const status = this.useSudo ? 'enabled' : 'disabled';
        vscode.window.showInformationMessage(`Shell Runner: Sudo mode ${status}`);

        vscode.commands.executeCommand('setContext', 'shell-runner.sudoMode', this.useSudo);
    }

    toggleClearTerminal()
    {
        this.clearTerminal = !this.clearTerminal;
        this.context.globalState.update('shell-runner.clearMode', this.clearTerminal);

        const status = this.clearTerminal ? 'enabled' : 'disabled';
        vscode.window.showInformationMessage(`Shell Runner: Clear terminal ${status}`);

        vscode.commands.executeCommand('setContext', 'shell-runner.clearMode', this.clearTerminal);
    }

    async runScript()
    {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
        {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        const document = editor.document;
        if (document.isDirty)
        {
            await document.save();
        }

        const filePath = document.fileName;

        if (!fs.existsSync(filePath))
        {
            vscode.window.showErrorMessage('File does not exist');
            return;
        }

        this.terminal = this.getOrCreateTerminal();
        this.terminal.show();

        if (this.clearTerminal)
        {
            this.terminal.sendText('clear');
        }

        const executablePath = path.isAbsolute(filePath) ? filePath : `./${path.basename(filePath)}`;
        let command = this.useSudo ? `sudo "${executablePath}"` : `"${executablePath}"`;

        const saved = this.savedArgs[filePath];
        const currentFileArgs = saved ? saved.args || '' : '';
        if (currentFileArgs.trim())
        {
            command += ` ${currentFileArgs}`;
        }

        this.terminal.sendText(command);
    }

    async setArgs()
    {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }

        const filePath = editor.document.fileName;
        const saved = this.savedArgs[filePath];
        const savedArgsForFile = saved ? saved.args : '';

        const args = await vscode.window.showInputBox({
            prompt: 'Enter arguments for the script',
            value: savedArgsForFile,
            placeHolder: 'e.g., --verbose input.txt'
        });

        if (args !== undefined)
        {
            this.savedArgs[filePath] = {
                args,
                lastUsed: Date.now()
            };
            const keys = Object.keys(this.savedArgs);
            if (keys.length > ShellRunner.max_saved_args)
            {
                // 按时间戳排序，删除最久未用的
                const sorted = keys.sort((a, b) => (this.savedArgs[a].lastUsed - this.savedArgs[b].lastUsed));
                const toDelete = sorted.slice(0, keys.length - ShellRunner.max_saved_args);
                for (const key of toDelete)
                {
                    delete this.savedArgs[key];
                }
            }

            await this.context.globalState.update('shell-runner.savedArgs', this.savedArgs);

            const message = args.trim() ? `Arguments set: ${args}` : 'Arguments cleared';
            vscode.window.showInformationMessage(message);
        }
    }

    private getOrCreateTerminal(): vscode.Terminal
    {
        if (this.terminal && this.terminal.exitStatus === undefined)
        {
            return this.terminal;
        }

        this.terminal = vscode.window.createTerminal({
            name: this.terminalName
        });

        return this.terminal;
    }

    static async makeExecutable()
    {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        const filePath = editor.document.fileName;
        try
        {
            const stats = await stat(filePath);
            if ((stats.mode & 0o100) === 0)
            {
                const action = await vscode.window.showWarningMessage(
                    'File is not executable. Make it executable?',
                    'Yes', 'Cancel'
                );
                if (action === 'Yes')
                {
                    const newMode = stats.mode | 0o100;
                    await chmod(filePath, newMode);

                    vscode.window.showInformationMessage(`Made "${path.basename(filePath)}" executable`);
                }
            }
            else
            {
                vscode.window.showInformationMessage(`"${path.basename(filePath)}" is already executable`);
            }
        }
        catch (error)
        {
            vscode.window.showErrorMessage(`Failed to make file executable: ${error}`);
        }
    }
}

export function activate(context: vscode.ExtensionContext)
{
    const shellRunner = new ShellRunner(context);

    const commands = [
        vscode.commands.registerCommand('shell-runner.run', () => shellRunner.runScript()),
        vscode.commands.registerCommand('shell-runner.setArgs', () => shellRunner.setArgs()),
        vscode.commands.registerCommand('shell-runner.toggleSudo', () => shellRunner.toggleSudoMode()),
        vscode.commands.registerCommand('shell-runner.toggleClear', () => shellRunner.toggleClearTerminal()),
        vscode.commands.registerCommand('shell-runner.makeExecutable', () => ShellRunner.makeExecutable())
    ];

    context.subscriptions.push(...commands);

    vscode.commands.executeCommand('setContext', 'shell-runner.sudoMode', shellRunner['useSudo']);
    vscode.commands.executeCommand('setContext', 'shell-runner.clearMode', shellRunner['clearTerminal']);
}

export function deactivate() { }
