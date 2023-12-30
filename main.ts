import { Stats, access, link, readFile, rename, stat } from 'fs';
import { App, CachedMetadata, Editor, EmbedCache, FileManager, FileSystemAdapter, LinkCache, MarkdownView, MetadataCache, Notice, Plugin, TAbstractFile, TFile, TFolder, Vault, Workspace, WorkspaceLeaf, normalizePath } from 'obsidian';
import { basename, dirname, extname, join, normalize, parse, sep } from 'path';

// References
//   general
//     [Obsidian Developer Documentation](https://docs.obsidian.md/Home)
//   suggest & modal
//     [main.ts - obsidian-redirect - jglev - Github](https://github.com/jglev/obsidian-redirect/blob/main/main.ts#L155)
//   file
//     [Vault](https://docs.obsidian.md/Plugins/Vault)
//     [Vault class](https://docs.obsidian.md/Reference/TypeScript+API/Vault)
//     access metadata
//       [getFileCache](https://docs.obsidian.md/Reference/TypeScript+API/metadatacache/getFileCache)
//     access file view (source and preview)
//       const view = this.app.workspace.getActiveViewOfType(MarkdownView);
//       access source view (edit view)
//         access text
//           [Editor](https://docs.obsidian.md/Plugins/Editor/Editor)
//             read and modify text
//           [Editor class](https://docs.obsidian.md/Reference/TypeScript+API/Editor)
//         access html
//           view.containerEl  (includes content and file-name)
//           view.contentEl
//       access preview view (reading view)
//         access html
//           view.containerEl  (includes content and file-name)
//           view.contentEl
//           [Markdown post processing](https://docs.obsidian.md/Plugins/Editor/Markdown+post+processing)
//             a post-processor of preview view
//             when open a preview view, it's called
//             can NOT get source view html-elements
//   callback
//     [Workspace class](https://docs.obsidian.md/Reference/TypeScript+API/Workspace)

export default class LinkFormatterPlugin extends Plugin {
	apis: SharedAPIs
	opis: ObsidianAPIs

	async onload() {
		this.apis = new SharedAPIs(this.app);
		this.opis = this.apis.obsidianAPIs;

		this.addCommand({
			id: 'redirector-format-links',
			name: 'Format links',
			callback: () => {
				this.command_formatLinks();
			}
		});
	}

	onunload() {
		
	}

	// TODO optimize
	async command_formatLinks() {
		// idle
		await this.idle();

		try {
			var countFilesChanged = await this.refreshAllLinks();
			new Notice('format finished, ' + countFilesChanged + ' files are changed');
			console.log(`${countFilesChanged} files are changed`);
		} catch (e) {
			console.log('format failed', e);
		}
		return;
	}

	// regenerate all links
	// return count of modified file
	async refreshAllLinks(): Promise<number> {
		var mdfiles = this.apis.obsidianAPIs.getMarkdownFiles();
		var mdfilesIterator = mdfiles.values();
		return await this.refreshAllLinks_loop(mdfilesIterator);
	}

	async refreshAllLinks_recurse(mdfilesIterator: IterableIterator<TFile>): Promise<number> {
		var nextElementContainer = mdfilesIterator.next();
		if (nextElementContainer.done) return 0;
		var file: TFile = nextElementContainer.value;

		var links = this.opis.tryGetInternalLinksDistinct(file);
		if (!links || links.length == 0) {
			return await this.refreshAllLinks_recurse(mdfilesIterator);
		}

		var pairs: LinkAndTargetFile[] = [];
		links.forEach((link) => {
			var targetFile = this.opis.tryGetLinkTarget(link.link, file.path);
			if (!targetFile) return;
			var pair = new LinkAndTargetFile(file, link, targetFile, this.opis);
			if (!pair.isLinkTextNeedUpdate()) return;
			pairs.push(pair);
		})

		if (pairs.length != 0) {
			var linksChanged = await this.replaceLinksInFile(pairs, file);
			var filesChanged = linksChanged >= 1 ? 1 : 0;
			return await this.refreshAllLinks_recurse(mdfilesIterator) + filesChanged;
		} else {
			return await this.refreshAllLinks_recurse(mdfilesIterator);
		}
	}

	async refreshAllLinks_loop(mdfilesIterator: IterableIterator<TFile>): Promise<number> {
		var count: number = 0;

		while(true) {
			var nextElementContainer = mdfilesIterator.next();
			if (nextElementContainer.done) break;
			var file: TFile = nextElementContainer.value;
	
			var links = this.opis.tryGetInternalLinksDistinct(file);
			if (!links || links.length == 0) {
				continue;
			}
	
			var pairs: LinkAndTargetFile[] = [];
			links.forEach((link) => {
				var targetFile = this.opis.tryGetLinkTarget(link.link, file.path);
				if (!targetFile) return;
				var pair = new LinkAndTargetFile(file, link, targetFile, this.opis);
				if (!pair.isLinkTextNeedUpdate()) return;
				pairs.push(pair);
			})
	
			if (pairs.length != 0) {
				var linksChanged = await this.replaceLinksInFile(pairs, file);
				var filesChanged = linksChanged >= 1 ? 1 : 0;
				count += filesChanged;
			}

			continue;
		}

		return count;
	}

	// return how many links is changed
	async replaceLinksInFile(pairs: LinkAndTargetFile[], file: TFile, log: boolean = true): Promise<number> {
		var linksChanged = 0;
		var oldLinks: string[] = [];
		var newLinks: string[] = [];

		pairs = this.sortPairsFromTailToHead(pairs);

		await this.opis.updateFile_async(file, (content) => {
			var newContent = content;
			var lines = this.strToLines(newContent);
			pairs.forEach((pair) => {
				var link = pair.link;
				var newTarget = pair.targetFile;

				// link info
				var linkStart = link.position.start;
				var linkEnd = link.position.end;
				var linkContent = link.original;
				var newLink = pair.getFreshMarkdownLink();
				if (newLink == linkContent) return;

				// try find link in lines
				var tryFoundLine = lines[linkStart.line];
				var tryFound = tryFoundLine.substring(linkStart.col, linkEnd.col);
				if (tryFound != linkContent) {
					if (log) {
						console.log(
							'\n' + 
							'can NOT locate link in file, \n' + 
							`file ${file.name}\n` + 
							`filepath ${file.path}\n` + 
							`expect ${linkContent}\n` + 
							`found ${tryFound}\n`);
					}
					return;
				}
	
				// has found link in content
				var foundLine = tryFoundLine;
				var found = tryFound;
				var prefix = foundLine.substring(0, linkStart.col);
				var suffix = foundLine.substring(linkEnd.col);
				
				// get new line
				var newLine = prefix + newLink + suffix;

				// replace in lines
				lines[linkStart.line] = newLine;

				// others
				linksChanged++;
				oldLinks.push(linkContent);
				newLinks.push(newLink);
			});

			newContent = this.linesToStr(lines);
			return newContent;
		});

		// log
		if (log) {
			if (linksChanged > 0) {
				var logContent = '';
				logContent += 
					'\n+++++ File Changed Log Start ++++++++++++++++' + 
					`\nfilename: ${file.name}\n` + 
					`\nfilepath: ${file.path}\n` + 
					`\ncountLinksChanged = ${linksChanged}`;
				for(var i=0; i<linksChanged; i++) {
					logContent += `\n- oldLink: ${oldLinks[i]}`;
					logContent += `\n  - newLink: ${newLinks[i]}`;
				}
				logContent += '\n------------- File Changed Log End -----\n';
				console.log(logContent);
			}
		}

		return linksChanged;
	}

	// the link closer to file-end will be put closer to array-start
	sortPairsFromTailToHead(pairs: LinkAndTargetFile[]): LinkAndTargetFile[] {
		var sorted = pairs.sort((a, b) => {
			var apos = a.link.position;
			var bpos = b.link.position;
			if (apos.end <= bpos.start) {
				return -1;
			} else if (bpos.end <= apos.start) {
				return 1;
			} else {
				throw new Error('failed to sort pairs');
				return 0;
			}
		})
		return sorted;
	}

	// sep str to lines
	strToLines(str: string, removeSeparatorFromLines: boolean = true, endOfLines : string[]= ['\r\n', '\n']): string[] {
		// sort sep from long to short
		endOfLines.sort((sep1, sep2) => {
			return sep1.length - sep2.length;
		});
		return this.strToLines_recurse(str, 0, endOfLines, removeSeparatorFromLines);
	}

	// sep str-from-a-index to lines
	private strToLines_recurse(str: string, strStartIdx: number, endOfLines : string[], removeSeparator: boolean, lines: string[] = []): string[] {
		// try to find next sep in each substr
		var isFoundSep = false;
		var prefix = '';  // includes sep or NOT, depends
		var theFoundSep = '';
		var suffixStartIdx = -1;  // NOT includes sep
		for(var i=strStartIdx; i<str.length; i++) {
			// each substr, is the str starts from i
			// is there a sep?
			for(var j=0; j<endOfLines.length; j++) {
				// each sep
				var sep = endOfLines[j];
				if (str.startsWith(sep, i)) {
					var sepStartIdx = i;
					var sepEndIdxExclusive = sepStartIdx + sep.length;
					isFoundSep = true;
					if (removeSeparator)
						prefix = str.substring(strStartIdx, sepStartIdx);
					else
						prefix = str.substring(strStartIdx, sepEndIdxExclusive);
					theFoundSep = sep;
					suffixStartIdx = sepEndIdxExclusive;
					break;
				}
			}
			if (isFoundSep) break;
		}

		// if NOT found next sep then
		if (!isFoundSep) {
			lines.push(str.substring(strStartIdx));
			return lines;
		}
		
		// found the sep
		lines.push(prefix);
		return this.strToLines_recurse(str, suffixStartIdx, endOfLines, removeSeparator, lines);
	}

	standardEndOfLine: string = '\n';
	linesToStr(strArr: string[]): string {
		var combined = '';
		strArr.forEach((str, idx) => {
			if (idx == 0)
				combined += str;
			else
				combined += this.standardEndOfLine + str;
		})
		return combined;
	}

	// await me to immediately return a async-function
	async idle() {}
}

class LinkAndTargetFile {
	readonly currentFile: TFile;
	readonly link: LinkCache;
	readonly targetFile: TFile;
	readonly opis: ObsidianAPIs;

	constructor(currentFile: TFile, link: LinkCache, targetFile: TFile, opis: ObsidianAPIs) {
		this.currentFile = currentFile;
		this.link = link;
		this.targetFile = targetFile;
		this.opis = opis;
	}

	getFreshMarkdownLink(): string {
		return this.opis.generateMarkdownLink(this.targetFile, this.currentFile.path);
	}

	isLinkTextNeedUpdate(): boolean {
		var fresh = this.getFreshMarkdownLink();
		var old = this.link.original;
		return fresh != old;
	}
}

class SharedAPIs {
	public obsidianAPIs: ObsidianAPIs;

	constructor(app: App) {
		this.obsidianAPIs = new ObsidianAPIs(app, this);
	}

	reportLog(message: string, throwError: boolean = true, toastsNotice: boolean = true, logConsole: boolean = true) {
		if (logConsole) {
			console.log('=========== Report Start ===========');
			console.log(message);
			console.trace();
		}
		if (toastsNotice) {
			new Notice(message);
			new Notice('see more log in console, \n' + 'Ctrl+Shift+I to open console');
		}
		if (throwError)
			throw new Error(message);
	}

	getPathSeparator_OSView(): string {
		return sep;
	}

	normalizePath_OSView(path: string): string {
		return normalize(path);
	}

	getParentPath_OSView(path: string): string {
		return dirname(path);
	}

	getName_OSView(path: string): string {
		return basename(path);
	}

	getPrefixName_OSView(path: string): string {
		return parse(path).name;
	}

	getSuffixName_OSView(path: string): string {
		return extname(path);
	}

	// 123.png -> '.png'
	// 123. -> ''
	// 123 -> ''
	getDotStartSuffixName_OSView(path: string): string {
		var suffixName = this.getSuffixName_OSView(path);
		if (suffixName == '' || suffixName == '.') return '';
		if (!suffixName.startsWith('.')) suffixName = '.' + suffixName;
		return suffixName;
	}

	// result is normalized
	concatPath_OSView(pathParts: string[]): string {
		if (pathParts.length == 0) {
			this.reportLog('zero args', true, false, true);
			throw new Error('report error');
		}
		if (pathParts.length == 1) {
			return this.normalizePath_OSView(pathParts[0]);
		}
		var path = pathParts[0];
		for (var i=1; i<pathParts.length; i++) {
			path = join(path, pathParts[i]);
		}
		return path;
	}

	// separate str to lines
	strToLines(str: string, removeSeparatorFromLines: boolean = true, separators: string[] = ['\r\n', '\n']): string[] {
		// sort sep from long to short
		separators.sort((sep1, sep2) => {
			return sep1.length - sep2.length;
		});
		return this.strToLinesBody(str, 0, separators, removeSeparatorFromLines);
	}

	// separate str-from-a-index to lines
	private strToLinesBody(str: string, strStartIdx: number, separators : string[], removeSeparator: boolean, lines: string[] = []): string[] {
		// try to find next sep in each substr
		var isFoundSep = false;
		var prefix = '';  // includes sep or NOT, depends
		var theFoundSep = '';
		var suffixStartIdx = -1;  // NOT includes sep
		for(var i=strStartIdx; i<str.length; i++) {
			// each substr, is the str starts from i
			// is there a sep?
			for(var j=0; j<separators.length; j++) {
				// each sep
				var sep = separators[j];
				if (str.startsWith(sep, i)) {
					var sepStartIdx = i;
					var sepEndIdxExclusive = sepStartIdx + sep.length;
					isFoundSep = true;
					if (removeSeparator)
						prefix = str.substring(strStartIdx, sepStartIdx);
					else
						prefix = str.substring(strStartIdx, sepEndIdxExclusive);
					theFoundSep = sep;
					suffixStartIdx = sepEndIdxExclusive;
					break;
				}
			}
			if (isFoundSep) break;
		}

		// if NOT found next sep then
		if (!isFoundSep) {
			lines.push(str.substring(strStartIdx));
			return lines;
		}
		
		// found the sep
		lines.push(prefix);
		return this.strToLinesBody(str, suffixStartIdx, separators, removeSeparator, lines);
	}

	linesToStr(strArr: string[], addSeparatorToLines: boolean = true, separator: string = '\n'): string {
		var combined = '';
		if (addSeparatorToLines) {
			strArr.forEach((str, idx) => {
				if (idx == 0)
					combined += str;
				else
					combined += separator + str;
			})
		} else {
			strArr.forEach((str) => {
				combined += str;
			})
		}
		return combined;
	}

	moveOrRename_withoutBackLinkUpdate_async(oldPath: string, newPath: string): Promise<void> {
		return new Promise<void>(
			(resolve, reject) => {
				try {
					rename(oldPath, newPath, 
						(err) => {
							try {
								if (err) {
									this.reportLog('failed to move or rename', false, false, true);
									reject(err);
									return;
								}
								resolve();
							} catch(e) {
								reject(e);
							}
						}
					);
				} catch(e) {
					reject(e);
				}
			}
		);
	}

	canAccess_async(path_OSView: string): Promise<boolean> {
		return new Promise<boolean>(
			(resolve, reject) => {
				access(path_OSView, (err) => {
					try {
						if (err) {
							this.reportLog(`can NOT access ${path_OSView}`, false, false, true);
							resolve(false);
							return;
						}
						resolve(true);
					} catch(e) {
						reject(e);
					}
				});
			}
		);
	}

	async exist_async(path_OSView: string): Promise<boolean> {
		return await this.canAccess_async(path_OSView);
	}

	getStats_async(path_OSView: string): Promise<Stats> {
		return new Promise<Stats>(
			(resolve, reject) => {
				stat(path_OSView, 
					(err, stats: Stats)=> {
						try {
							if (err) {
								this.reportLog(`can NOT get stats for ${path_OSView}`, false, false, true);
								reject(err);
								return;
							}
							resolve(stats);
						} catch(e) {
							reject(e);
						}
					})
			}
		);
	}

	async getSize_async(path_OSView: string) {
		return (await this.getStats_async(path_OSView)).size;
	}

	getByteArray_async(path_OSView: string): Promise<Buffer> {
		return new Promise<Buffer>(
			(resolve, reject) => {
				readFile(path_OSView, 
					(err, data: Buffer) => {
						try {
							if (err) {
								this.reportLog(`can NOT read file ${path_OSView}`, true, false, true);
								reject(err);
								return;
							}
	
							resolve(data);
						} catch(e) {
							reject(e);
						}
					});
			}
		);
	}

	byteArrayToArrayBuffer(buffer: Buffer): ArrayBuffer {
		var arrayBuffer = new ArrayBuffer(buffer.length);
		var byteView = new DataView(arrayBuffer);
		for (var i = 0; i < buffer.length; ++i) {
			byteView.setUint8(i, buffer.readUint8(i));
		}
		return arrayBuffer;
	  }

	async readBytes_async(path_OSView: string): Promise<ArrayBuffer> {
		var buffer = await this.getByteArray_async(path_OSView);
		return this.byteArrayToArrayBuffer(buffer);
	}

	successAfterMs_async(interval_ms: number): Promise<void> {
		return new Promise<void>(
			(resolve, reject) => {
				setTimeout(() => {
					try {
						resolve();
					} catch(e) {
						reject(e);
					}
				}, interval_ms);
			}
		);
	}
}

class ObsidianAPIs {
	private app: App;
	private sharedAPIs: SharedAPIs;

	constructor(app: App, sharedAPIs: SharedAPIs) {
		this.app = app;
		this.sharedAPIs = sharedAPIs;
	}

	getApp(): App {
		return this.app;
	}

	getWorkspace(): Workspace {
		return this.getApp().workspace;
	}

	getVault(): Vault {
		return this.getApp().vault;
	}

	getFileManager(): FileManager {
		return this.getApp().fileManager;
	}

	getMetadataCache(): MetadataCache {
		return this.getApp().metadataCache;
	}

	getFileSystemAdapter(): FileSystemAdapter {
		var adapter = this.getVault().adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			this.sharedAPIs.reportLog('can NOT get FileSystemAdapter', true, false, true);
			throw new Error('report error');
		}
		return adapter;
	}

	getActiveMarkdownView(): MarkdownView {
		const view = this.getWorkspace().getActiveViewOfType(MarkdownView);
		if (!view) {
			this.sharedAPIs.reportLog('can NOT get active MarkdownView', true, false, true);
			throw new Error('report error');
		}
		return view;
	}

	getActiveMarkdownViewEditor(): Editor {
		return this.getActiveMarkdownView().editor;
	}

	async updateFile_async(file: TFile, callback: (fileContent: string) => string) {
		await this.getVault().process(file, callback);
	}

	async readFile_async(file: TFile): Promise<string> {
		return await this.getVault().read(file);
	}

	async readFileBinary_async(file: TFile): Promise<ArrayBuffer> {
		return await this.getVault().readBinary(file);
	}

	async writeFile_async(file: TFile, data: string) {
		await this.getVault().modify(file, data);
	}

	async writeFileBinary_async(file: TFile, data: ArrayBuffer) {
		await this.getVault().modifyBinary(file, data);
	}

	async deleteFile_async(file: TFile) {
		await this.getVault().delete(file);
	}

	async deleteFileIfExist_async(path: string) {
		var file = this.tryGetFile(path);
		if (!file) return;
		await this.getVault().delete(file);
	}

	async deleteFiles_async(files: TFile[]) {
		await this.deleteFiles_body_async(files, 0);
	}

	private async deleteFiles_body_async(files: TFile[], cursor_deleteThisAndAllFollowing: number) {
		if (cursor_deleteThisAndAllFollowing >= files.length) return;

		var currentFile = files[cursor_deleteThisAndAllFollowing];
		await this.deleteFile_async(currentFile);
		await this.deleteFiles_body_async(files, cursor_deleteThisAndAllFollowing + 1);
	}

	async tryDeleteFiles_async(files: TFile[]) {
		await this.tryDeleteFiles_async_body(files, 0);
	}

	private async tryDeleteFiles_async_body(files: TFile[], cursor_deleteThisAndAllFollowing: number) {
		if (cursor_deleteThisAndAllFollowing >= files.length) return;

		var currentFile = files[cursor_deleteThisAndAllFollowing];
		try {
			await this.deleteFile_async(currentFile);
		} catch(error) {
			console.log(`failed to delete "${currentFile.name}" at "${currentFile.path}" because:`);
			console.log(error);
		}
		await this.deleteFiles_body_async(files, cursor_deleteThisAndAllFollowing + 1);
	}

	async createFile_async(path: string, content: string): Promise<TFile> {
		var file = this.tryGetFile(path);
		if (file) {
			this.sharedAPIs.reportLog('want to create a file, but it already exist', true, false, true);
			throw new Error('report error');
		}
		return await this.getVault().create(path, content);
	}

	async createFileIfNOTExist_async(path: string, content: string): Promise<TFile> {
		var file = this.tryGetFile(path);
		if (file) return file;
		return await this.getVault().create(path, content);
	}

	// [Workspace](https://docs.obsidian.md/Plugins/User+interface/Workspace)
	// [Workspace class](https://docs.obsidian.md/Reference/TypeScript+API/Workspace)
	// [Workspace.getLeaf() method](https://docs.obsidian.md/Reference/TypeScript+API/workspace/getLeaf_1)
	// split display all the childs
	// tabs display one of childs, at any moment
	async openFile_async(
		file: TFile
	) {
		let leaf: WorkspaceLeaf;

		// open file in new tab
		leaf = this.getWorkspace().getLeaf('tab');
		await leaf.openFile(file);
	
		// focus
		this.getWorkspace().setActiveLeaf(leaf, { focus: true });
	
		// source view
		const leafViewState = leaf.getViewState();
		await leaf.setViewState({
			...leafViewState,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			state: {
				...leafViewState.state,
				mode: 'source',
			},
		});
	}

	// [Move file to other locations dynamically using callbacks](https://forum.obsidian.md/t/move-file-to-other-locations-dynamically-using-callbacks/64334)
	// change the path
	async move_fileOrDirectory_async(fileOrDirectory: TAbstractFile, newPath: string) {
		await this.getFileManager().renameFile(fileOrDirectory, newPath);
	}

	// rename a file
	async rename_fileOrDirectory_async(fileOrDirectory: TAbstractFile, newName: string) {
		if (newName.contains(this.getPathSeparator_ObsidianView())) {
			throw new Error('filename should NOT contain path-separator');
		}

		// parent
		var parentPath = fileOrDirectory.parent?.path;
		if (!parentPath) parentPath = '';
		// concat
		var newPath = this.concatDirectoryPathAndFileName_ObsidianView(
			parentPath, 
			newName
		);
		
		await this.move_fileOrDirectory_async(fileOrDirectory, newPath);
	}

	async renameFilePrefixName_async(file: TFile, newPrefix: string) {
		var suffix = this.getFileSuffixName_ObsidianView(file);
		if (!suffix.startsWith('.')) suffix = '.' + suffix;
		var newName = newPrefix + suffix;
		
		await this.rename_fileOrDirectory_async(file, newName);
	}

	async renameFileSuffixName_async(file: TFile, newSuffix: string) {
		if (!newSuffix.startsWith('.')) newSuffix = '.' + newSuffix;

		var prefix = this.getFilePrefixName_ObsidianView(file);
		var newName = prefix + newSuffix;
		
		await this.rename_fileOrDirectory_async(file, newName);
	}

	getAllLoadedFilesAndDirectories(): TAbstractFile[] {
		return this.getVault().getAllLoadedFiles();
	}

	getAllLoadedFiles(): TFile[] {
		return this.getAllLoadedFilesAndDirectories().flatMap<TFile>(
			fileOrDir => {
				if (fileOrDir instanceof TFile)
					return fileOrDir;
				return [];
			}
		);
	}

	getMarkdownFiles(): TFile[] {
		return this.getVault().getMarkdownFiles();
	}

	// don't forget suffix .md
	tryGetFile(path: string): TFile | null {
		var file: TFile | null = null;
		var fileOrFolder = this.getVault().getAbstractFileByPath(path);
		if (!fileOrFolder) return null;
		if (fileOrFolder instanceof TFile) {
			file = fileOrFolder;
		}
		return file;
	}

	getFile(path: string): TFile {
		var fileOrNull: TFile | null = this.tryGetFile(path);
		if (!fileOrNull) {
			this.sharedAPIs.reportLog('can NOT find file', true, false, true);
			throw new Error('report error');
		}
		var file = fileOrNull;
		return file;
	}

	tryGetFiles(paths_ObsidianView: string[]): TFile[] | null {
		var result: TFile[] = [];
		for(var i=0; i<paths_ObsidianView.length; i++) {
			var path = paths_ObsidianView[i];
			var maybeFile = this.tryGetFile(path);
			if (!maybeFile)
				return null;
			result.push(maybeFile);
		}
		return result;
	}

	getActiveFile(): TFile {
		var fileOrNull = this.getWorkspace().getActiveFile();
		if (!fileOrNull) {
			this.sharedAPIs.reportLog('can NOT find active file', true, false, true);
			throw new Error('report error');
		}
		return fileOrNull;
	}

	tryGetActiveFile(): TFile | null {
		return this.getWorkspace().getActiveFile();
	}

	tryGetFileMetadata(file: TFile): CachedMetadata | null {
		return this.getMetadataCache().getFileCache(file);
	}

	tryGetDirectory(path: string): TFolder | null {
		var folder: TFolder | null = null;
		var fileOrFolder = this.getVault().getAbstractFileByPath(path);
		if (!fileOrFolder) return null;
		if (fileOrFolder instanceof TFolder) {
			folder = fileOrFolder;
		}
		return folder;
	}

	// at current file, try to get the target of link
	tryGetLinkTarget(link: string, pathOfCurrentFile: string): TFile | null {
		return this.getMetadataCache().getFirstLinkpathDest(link, pathOfCurrentFile);
	}

	// at current file, generate the markdown link of target file
	generateMarkdownLink(targetFile: TFile, pathOfCurrentFile: string): string {
		return this.getFileManager().generateMarkdownLink(targetFile, pathOfCurrentFile);
	}

	// embed + non-embed links
	// if at least 1 link, return links, 
	// else return null
	tryGetInternalLinks(file: TFile): LinkCache[] | null {
		var links: LinkCache[] = [];
		var nonEmbeds = this.tryGetInternalNonEmbedLinks(file);
		if (nonEmbeds) links = links.concat(nonEmbeds);
		var embeds = this.tryGetInternalEmbedLinks(file);
		if (embeds) links = links.concat(embeds);
		if (links.length == 0) return null;
		return links;
	}

	// remove duplicate links
	// if at least 1 link, return links, 
	// else return null
	tryGetInternalLinksDistinct(file: TFile): LinkCache[] | null {
		var links = this.tryGetInternalLinks(file);
		if (!links) return null;
		var linksDistinct: LinkCache[] = [];
		links.forEach(
			link => {
				if (!linksDistinct.some(
					addedLink => {
						addedLink.link == link.link
					}
				)) {
					linksDistinct.push(link);
				}
				return;
			}
		);
		if (linksDistinct.length == 0) return null;
		return linksDistinct;
	}

	// do NOT contain embedded links like ![]()
	// if at least 1 link, return links, 
	// else return null
	tryGetInternalNonEmbedLinks(file: TFile): LinkCache[] | null {
		var metadata = this.tryGetFileMetadata(file);
		if (!metadata) return null;
		var links = metadata.links;
		if (!links || links.length == 0) return null;
		return links;
	}

	// links like ![]()
	// if at least 1 link, return links, 
	// else return null
	tryGetInternalEmbedLinks(file: TFile): EmbedCache[] | null {
		var metadata = this.tryGetFileMetadata(file);
		if (!metadata) return null;
		var embeds = metadata.embeds;
		if (!embeds || embeds.length == 0) return null;
		return embeds;
	}

	private sep: string = '';
	getPathSeparator_ObsidianView(): string {
		if (this.sep == '') {
			this.sep = this.normalizePath_ObsidianView('/');
			// if normalizePath_ObsidianView() do NOT tell me the separator
			if (this.sep == '') this.sep = '/';
			// check it before return
			if (!['/', '\\'].includes(this.sep)) {
				this.sharedAPIs.reportLog('the accquired path-separator is strange, it\'s ' + this.sep + ' , so stop the execution', true, false, true);
				throw new Error('report error');
			}
		}
		return this.sep;
	}

	normalizePath_ObsidianView(path: string): string {
		return normalizePath(path);
	}

	concatDirectoryPathAndFileName_ObsidianView(dirPath: string, fileName: string): string {
		var concated: string = '';
		// get path separator & normalize path
		var sep = this.getPathSeparator_ObsidianView();
		var dirPathAsPrefix = this.normalizePath_ObsidianView(dirPath);
		// is root dir?
		var rootDir = false;
		if (dirPathAsPrefix == '' || dirPathAsPrefix == sep) {
			rootDir = true;
		}
		// prepare prefix, the dir path
		if (rootDir) {
			dirPathAsPrefix = '';
		} else {
			if (!dirPathAsPrefix.endsWith(sep)) {
				dirPathAsPrefix += sep;
			}
		}
		// concat & normalize
		concated = this.normalizePath_ObsidianView(dirPathAsPrefix + fileName);
		// return
		return concated;
	}

	getFilePath_ObsidianView(file: TFile): string {
		return file.path;
	}

	getFileFolder_ObsidianView(file: TFile): string {
		return this.getFileDirectory_ObsidianView(file);
	}

	getFileDirectory_ObsidianView(file: TFile): string {
		var parent = file.parent;
		var dirPath = parent ? parent.path : '';
		dirPath = this.normalizePath_ObsidianView(dirPath);
		return dirPath;
	}

	getFileName_ObsidianView(file: TFile): string {
		return file.name;
	}

	getFilePrefixName_ObsidianView(file: TFile): string {
		return file.basename;
	}

	getFileSuffixName_ObsidianView(file: TFile): string {
		return file.extension;
	}

	// 123.png -> '.png'
	// 123. -> ''
	// 123 -> ''
	getFileDotStartSuffixName_ObsidianView(file: TFile): string {
		var suffixName = this.getFileSuffixName_ObsidianView(file);
		if (suffixName == '' || suffixName == '.') return '';
		if (!suffixName.startsWith('.')) suffixName = '.' + suffixName;
		return suffixName;
	}

	getFileSize(file: TFile): number {
		return file.stat.size;
	}

	getVaultPath_OSView(): string {
		var adapter = this.getFileSystemAdapter();
		var maybePath = adapter.getBasePath();
		maybePath = this.sharedAPIs.normalizePath_OSView(maybePath);
		return maybePath;
	}

	getFilePath_OSView(file: TFile): string {
		return this.getPath_OSView(file.path);
	}

	getPath_OSView(path_ObsidianView: string): string {
		var vaultPath_OSView = this.getVaultPath_OSView();
		var vaultToFile_OSView = path_ObsidianView;
		return this.sharedAPIs.concatPath_OSView([vaultPath_OSView, vaultToFile_OSView]);
	}

	// 1s == 1000ms
	// m == 10^-3
	waitUntilTFilesReady_async(paths_ObsidianView: string[], timeOut_ms: number = 3000, recheckInterval_ms: number = timeOut_ms / 10): Promise<TFile[]> {
		return new Promise<TFile[]>(
			(resolve, reject) => {
				const startDate = new Date();
				const startTime_ms = startDate.getTime();
				this.waitUntilTFilesReady_mainLoop_detached_resolveOrReject(
					paths_ObsidianView, 
					timeOut_ms, 
					recheckInterval_ms, 
					startTime_ms, 
					resolve, 
					reject
				);
			}
		);
	}

	private waitUntilTFilesReady_mainLoop_detached_resolveOrReject(
				paths_ObsidianView: string[], timeOut_ms: number, recheckInterval_ms: number, startTime_ms: number, 
				resolve:(value: TFile[] | PromiseLike<TFile[]>) => void, reject: (reason?: any) => void) {
		try {
			// check timeout
			// try
			// |-- ok! ------------------> resolve return
			// wait interval
			// loop
			// check time out
			var currentDate = new Date();
			var currentTime = currentDate.getTime();
			var isTimeOut = currentTime - startTime_ms > timeOut_ms;
			if (isTimeOut) {
				reject(`when wait TFiles to be ready, \ntime out, wait ${new Date().getTime() - startTime_ms} ms in total`);
				return;
			}

			// try
			var maybeAllTFiles = this.tryGetFiles(paths_ObsidianView);
			if (maybeAllTFiles) {
				// ok!
				resolve(maybeAllTFiles);
				return;
			}

			// wait
			this.sharedAPIs.successAfterMs_async(recheckInterval_ms).then(
				() => {
					try {
						this.waitUntilTFilesReady_mainLoop_detached_resolveOrReject(
							paths_ObsidianView, 
							timeOut_ms, 
							recheckInterval_ms, 
							startTime_ms, 
							resolve, 
							reject
						);
					} catch(e) {
						reject(e);
					}
				}
			).catch(
				reason => {
					reject(reason);
				}
			);
		} catch(e) {
			reject(e);
		}
	}

	imageExts = ['.jpeg', '.png', '.jpg'];
	isImage(file: TFile) {
		var name = this.getFileName_ObsidianView(file);
		var ext = this.getFileSuffixName_ObsidianView(file);
		if (ext.length <= 0 || ext.length >= name.length) {
			return false;
		}

		if (!ext.startsWith('.')) {
			ext = '.' + ext;
		}

		if (this.imageExts.includes(ext)) {
			return true;
		}
		return false;
	}

	getAllImageFiles(): TFile[] {
		return this.getAllLoadedFilesAndDirectories().flatMap<TFile>(
			(fileOrDir: TAbstractFile) => {
				if (fileOrDir instanceof TFile) {
					var file: TFile = fileOrDir;
					if (this.isImage(file)) {
						return file;
					}
				}
				return [];
			}
		)
	}
}
