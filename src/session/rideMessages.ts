/* eslint-disable  @typescript-eslint/naming-convention */
export interface AppendSessionOutputMessage {
	result: string;
}
export interface CloseWindowMessage {
	win: number;
}
export interface DisconnectMessage {
	message: string;
}
export interface EchoInputMessage {
	input: string;
}
export interface GetHelpInformationMessage {
	line: string;
	pos: number;
}
export interface GotoWindowMessage {
	win: number;
}
export interface HadErrorMessage {
	dmx: number;
	error: number;
}
export interface InterpreterStatusMessage {
	CompactCount: number;
	DQ: number;
	GarbageCount: number;
	IO: number;
	ML: number;
	NumThreads: number;
	SI: number;
	TID: number;
	TRAP: number;
	WA: number;
}
export interface IdentifyMessage {
	Port: number;
	IPAddress: string;
	Vendor: string;
	Language: string;
	version: string;
	Machine: string;
	arch: string;
	Project: string;
	Process: string;
	User: string;
	pid: number,
	token: string;
	date: string;
	platform: string;
}
export interface InternalErrorMessage {
	error: number;
	error_text: string;
	dmx: string;
	message: string;
}
export interface NotificationMessage {
	message: string;
	token: number;
}
export interface OpenWindowMessage {
	currentRow: number;
	debugger: number;
	entityType: number;
	filename: string;
	monitor: number[];
	name: string;
	offset: number;
	readOnly: number;
	size: number;
	stop: number[];
	text: string[];
	tid: number;
	tname: string;
	token: number;
	trace: number[];
}
export interface OptionsDialogMessage {
	options: string[];
	text: string;
	title: string;
	token: number;
	type: number;
}
export interface ReplyClearTraceStopMonitorMessage {
	monitors: number;
	stops: number;
	token: number;
	traces: number;
}
export interface ReplyFormatCodeMessage {
	win: number;
	text: string[];
}
export interface ReplyGetAutocompleteMessage {
	options: string[];
	skip: number;
	token: number;
}
export interface ReplyGetConfigurationMessage {
	configurations: {
		name: string;
		value: string;
	}[];
}
export interface ReplyGetHelpInformationMessage {
	url: string;
}
export interface ReplyGetLanguageBarMessage {
	entries: {
		name: string;
		avchar: string;
		helptext: string;
	}[];
}
export interface ReplyGetLogMessage {
	result: string[];
}
export interface ReplyGetSIStackMessage {
	stack: {
		description: string;
		filecount: number;
		fileline: number;
		filename: string;
	}[];
	tid: number;
}
export interface ReplyGetSyntaxInformationMessage {
	idioms: string[];
}
export interface ReplyGetThreadsMessage {
	threads: {
		description: string;
		state: string;
		flags: string;
		Treq: string;
		tid: number;
	}[];
}
export interface ReplySaveChangesMessage {
	err: number;
	win: number;
}
export interface ReplyTreeListMessage {
	nodeId: number;
	nodeIds: number[];
	names: string[],
	classes: number[];
	err: string;
}
export interface SetHighlightLineMessage {
	line: number;
	win: number;
}
export interface SetPromptTypeMessage {
	type: number;
}
export interface ShowHTMLMessage {
	title: string;
	html: string;
}
export interface StatusOutputMessage {
	text: string;
	flags: number;
}
export interface StringDialogMessage {
	defaultValue: string;
	initialValue: string;
	text: string;
	title: string;
	token: number;
}
export interface SysErrorMessage {
	text: string;
	stack: string;
}
export interface TaskDialogMessage {
	buttonText: string[];
	footer: string;
	options: string[];
	subtext: string;
	text: string;
	title: string;
	token: number;
}
export interface UnknownCommandMessage {
	name: string;
}
export interface UpdateDisplayNameMessage {
	displayName: string;
}
export interface ValueTipMessage {
	class: number;
	startCol: number;
	endCol: number;
	token: number;
	tip: string[];
}
export interface WindowTypeChangedMessage {
	tracer: number;
	win: number;
}
export type RideMessage = [string,
	AppendSessionOutputMessage | CloseWindowMessage | DisconnectMessage | EchoInputMessage |
	GetHelpInformationMessage | GotoWindowMessage | HadErrorMessage |
	IdentifyMessage | InterpreterStatusMessage | InternalErrorMessage |
	NotificationMessage | OpenWindowMessage |
	OptionsDialogMessage | ReplyClearTraceStopMonitorMessage | ReplyFormatCodeMessage |
	ReplyGetAutocompleteMessage | ReplyGetConfigurationMessage |
	ReplyGetHelpInformationMessage | ReplyGetLanguageBarMessage | ReplyGetLogMessage |
	ReplyGetSIStackMessage | ReplyGetSyntaxInformationMessage | ReplyGetThreadsMessage |
	ReplySaveChangesMessage | ReplyTreeListMessage | SetHighlightLineMessage |
	StringDialogMessage | TaskDialogMessage |
	SetPromptTypeMessage | ShowHTMLMessage | StatusOutputMessage |
	SysErrorMessage | UnknownCommandMessage | UpdateDisplayNameMessage |
	ValueTipMessage | WindowTypeChangedMessage
];
