import * as vscode from 'vscode';
import { handleChatRequest } from './chatParticipant';
import { registerChatTools } from './chatTools';

export function activate(context: vscode.ExtensionContext) {
	// ─── Chat Participant Registration ────────────────────────────────────────
	const participant = vscode.chat.createChatParticipant(
		'pmChat.chat',
		handleChatRequest,
	);

	// Register advanced tools (fix, edit, etc.)
	registerChatTools(context);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(globalThis as any).console?.log('[PM Chat Participant] Active');

	context.subscriptions.push(participant);
}

export function deactivate() {
	// cleanup se necessario
}