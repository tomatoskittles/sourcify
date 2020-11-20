import bunyan from 'bunyan';
import Web3 from 'web3';
import { StringMap } from '@ethereum-sourcify/core';
import AdmZip from 'adm-zip';
import fs from 'fs';
import Path from 'path';
import CheckedContract from './CheckedContract';
const fetch = require("node-fetch");

/**
 * Regular expression matching metadata nested within another json.
 */
const NESTED_METADATA_REGEX = /"{\\"compiler\\":{\\"version\\".*?},\\"version\\":1}"/;

const GITHUB_REGEX = /^https?:\/\/github.com/;

const IPFS_PREFIX = "dweb:/ipfs/";

export class PathBuffer {
    path?: string;
    buffer: Buffer;

    constructor(buffer: Buffer, path?: string) {
        this.buffer = buffer;
        this.path = path;
    }
}

class PathContent {
    path: string;
    content: string;

    constructor(content: string, path?: string) {
        this.content = content;
        this.path = path;
    }
}

export interface SourceMap {
    [compiledPath: string]: PathContent;
}

export interface IValidationService {
    /**
     * Checks all metadata files found in the provided paths. Paths may include regular files, directoris and zip archives.
     * 
     * @param paths The array of paths to be searched and checked.
     * @param ignoring Optional array where all unreadable paths can be stored.
     * @returns An array of CheckedContract objects.
     * @throws Error if no metadata files are found.
     */
    checkPaths(paths: string[], ignoring?: string[]): Promise<CheckedContract[]>;

    /**
     * Checks the files provided in the array of Buffers. May include buffers of zip archives.
     * Attempts to find all the resources specified in every metadata file found.
     * 
     * @param files The array of buffers to be checked.
     * @returns An array of CheckedContract objets.
     * @throws Error if no metadata files are found.
     */
    checkFiles(files: PathBuffer[]): Promise<CheckedContract[]>;
}

export class ValidationService implements IValidationService {
    logger: bunyan;

    /** Should fetch missing sources */
    fetch: boolean;
    /**
     * @param logger a custom logger that logs all errors; undefined or no logger provided turns the logging off
     */
    constructor(logger?: bunyan, fetch?: false) {
        this.logger = logger;
        this.fetch = fetch;
    }

    checkPaths(paths: string[], ignoring?: string[]): Promise<CheckedContract[]> {
        const files: PathBuffer[] = [];
        paths.forEach(path => {
            if (fs.existsSync(path)) {
                this.traversePathRecursively(path, filePath => {
                    const fullPath = Path.resolve(filePath);
                    const file = new PathBuffer(fs.readFileSync(filePath), fullPath);
                    files.push(file);
                });
            } else if (ignoring) {
                ignoring.push(path);
            }
        });

        return this.checkFiles(files);
    }

    async checkFiles(files: PathBuffer[]): Promise<CheckedContract[]> {
        const inputFiles = this.findInputFiles(files);
        const parsedFiles = inputFiles.map(pathBuffer => new PathContent(pathBuffer.buffer.toString(), pathBuffer.path));
        const metadataFiles = this.findMetadataFiles(parsedFiles);

        const checkedContracts: CheckedContract[] = [];
        const errorMsgMaterial: string[] = [];

        for (const metadata of metadataFiles) {
            const { foundSources, missingSources, invalidSources } = await this.rearrangeSources(metadata, parsedFiles);
            const checkedContract = new CheckedContract(metadata, foundSources, missingSources, invalidSources);
            checkedContracts.push(checkedContract);
            if (!checkedContract.isValid()) {
                errorMsgMaterial.push(checkedContract.info);
            }
        }

        if (errorMsgMaterial.length) {
            const msg = errorMsgMaterial.join("\n");
            this.log(msg);
        }

        return checkedContracts;
    }

    /**
     * Traverses the given files, unzipping any zip archive.
     * 
     * @param files the array containing the files to be checked
     * @returns an array containing the provided files, with any zips being unzipped and returned
     */
    private findInputFiles(files: PathBuffer[]): PathBuffer[] {
        const inputFiles: PathBuffer[] = [];
        for (const file of files) {
            if (this.isZip(file.buffer)) {
                this.unzip(file, files);
            } else {
                inputFiles.push(file);
            }
        }

        return inputFiles;
    }

    /**
     * Checks whether the provided file is in fact zipped.
     * @param file the buffered file to be checked
     * @returns true if the file is zipped; false otherwise
     */
    private isZip(file: Buffer): boolean {
        try {
            new AdmZip(file);
            return true;
        } catch (err) { undefined }
        return false;
    }

    /**
     * Unzips the provided file buffer to the provided array.
     * 
     * @param zippedFile the buffer containin the zipped file to be unpacked
     * @param files the array to be filled with the content of the zip
     */
    private unzip(zippedFile: PathBuffer, files: PathBuffer[]): void {
        const timestamp = Date.now().toString();
        const tmpDir = `tmp-unzipped-${timestamp}`;

        new AdmZip(zippedFile.buffer).extractAllTo(tmpDir);

        this.traversePathRecursively(tmpDir, filePath => {
            const file = new PathBuffer(fs.readFileSync(filePath), zippedFile.path);
            files.push(file);
        });
        this.traversePathRecursively(tmpDir, fs.unlinkSync, fs.rmdirSync);
    }

    /**
     * Selects metadata files from an array of files that may include sources, etc
     * @param  {string[]} files
     * @return {string[]}         metadata
     */
    private findMetadataFiles(files: PathContent[]): any[] {
        const metadataCollection = [];

        for (const file of files) {
            let metadata = this.extractMetadataFromString(file.content);
            if (!metadata) {
                const matchRes = file.content.match(NESTED_METADATA_REGEX);
                if (matchRes) {
                    metadata = this.extractMetadataFromString(matchRes[0]);
                }
            }

            if (metadata) {
                const compilationTargetsNumber = Object.keys(metadata.settings.compilationTarget).length;
                const expectedTargetsNumber = 1;
                if (compilationTargetsNumber !== expectedTargetsNumber) {
                    const msg = `Metadata (${file.path}) specifying ${compilationTargetsNumber} entries in compilationTarget; should be: ${expectedTargetsNumber}`;
                }
                metadataCollection.push(metadata);
            }
        }

        if (!metadataCollection.length) {
            const msg = "Metadata file not found. Did you include \"metadata.json\"?";
            this.log(msg);
            throw new Error(msg);
        }

        return metadataCollection;
    }

    /**
     * Validates metadata content keccak hashes for all files and
     * returns mapping of file contents by file name
     * @param  {any}       metadata
     * @param  {string[]}  files    source files
     * @return foundSources, missingSources, invalidSources
     */
    private async rearrangeSources(metadata: any, files: PathContent[]) {
        const foundSources: SourceMap = {};
        const missingSources: any = {};
        const invalidSources: StringMap = {};
        const hash2file = this.storeByHash(files);

        for (const fileName in metadata.sources) {
            const sourceInfo = metadata.sources[fileName];
            let file = new PathContent(undefined);
            file.content = sourceInfo.content;
            const hash: string = sourceInfo.keccak256;
            if (file.content) {
                if (Web3.utils.keccak256(file.content) != hash) {
                    const msg = "The calculated and the provided hash values don't match.";
                    invalidSources[fileName] = msg;
                    continue;
                }
            } else {
                file = hash2file.get(hash) || file;
            }

            if (!file.content && sourceInfo.urls) {
                const fetched = await this.processFetching(fileName, sourceInfo.urls, hash);
                if (fetched) {
                    hash2file.set(hash, file);
                    file.content = fetched;
                }
            }

            if (file.content) {
                foundSources[fileName] = file;
            } else {
                missingSources[fileName] = { keccak256: hash, urls: sourceInfo.urls };
            }
        }

        return { foundSources, missingSources, invalidSources };
    }

    /**
     * Generates a map of files indexed by the keccak hash of their content.
     * 
     * @param  {string[]}  files Array containing sources.
     * @returns Map object that maps hash to PathContent.
     */
    private storeByHash(files: PathContent[]): Map<string, PathContent> {
        const byHash: Map<string, PathContent> = new Map();

        for (const i in files) {
            const calculatedHash = Web3.utils.keccak256(files[i].content);
            byHash.set(calculatedHash, files[i]);
        }
        return byHash;
    }

    private async processFetching(fileName: string, urls: string[], hash: string): Promise<string> {
        fileName = fileName.trim();
        if (GITHUB_REGEX.test(fileName)) { // TODO test this case
            const rawGithubUrl = fileName.replace("github", "raw.githubusercontent");
            return this.performFetch(fileName, rawGithubUrl, hash);

        } else if (fileName.startsWith("@openzeppelin")) {
            for (const url of urls) {
                if (url.startsWith(IPFS_PREFIX)) {
                    const ipfsCode = url.slice(IPFS_PREFIX.length);
                    const ipfsUrl = 'https://ipfs.infura.io:5001/api/v0/cat?arg='+ipfsCode;
                    return this.performFetch(fileName, ipfsUrl, hash);
                }
            }
        }
        return null;
    }

    private async performFetch(fileName: string, url: string, hash: string): Promise<string> {
        this.log(`Fetching of ${fileName} from ${url}`);
        const res = await fetch(url);
        if (res.status === 200) {
            const content = await res.text();
            if (Web3.utils.keccak256(content) !== hash) {
                this.log("The provided hash value does not match the calculated hash value of the fetched file.");
                return null;
            }

            this.log(`Successful fetching of ${fileName} from ${url}`);
            return content;

        } else {
            this.log(`Failed fetching of ${fileName} from ${url}`);
            return null;
        }
    }

    private extractMetadataFromString(file: string): any {
        try {
            let obj = JSON.parse(file);
            if (this.isMetadata(obj)) {
                return obj;
            }

            // if the input string originates from a file where it was double encoded (e.g. truffle)
            obj = JSON.parse(obj);
            if (this.isMetadata(obj)) {
                return obj;
            }
        } catch (err) { undefined }

        return null;
    }

    /**
     * A method that checks if the provided object was generated as a metadata file of a Solidity contract.
     * Current implementation is rather simplistic and may require further engineering.
     * 
     * @param metadata the JSON to be checked
     * @returns true if the provided object is a Solidity metadata file; false otherwise
     */
    private isMetadata(obj: any): boolean {
        return  (obj.language === "Solidity") &&
                !!obj.compiler;
    }

    /**
     * Applies the provided worker function to the provided path recursively.
     * 
     * @param path the path to be traversed
     * @param worker the function to be applied on each file that is not a directory
     * @param afterDir the function to be applied on the directory after traversing its children
     */
    private traversePathRecursively(path: string, worker: (filePath: string) => void, afterDirectory?: (filePath: string) => void) {
        if (!fs.existsSync(path)) {
            const msg = `Encountered a nonexistent path: ${path}`;
            this.log(msg);
            throw new Error(msg);
        }

        const fileStat = fs.lstatSync(path);
        if (fileStat.isFile()) {
            worker(path);
        } else if (fileStat.isDirectory()) {
            fs.readdirSync(path).forEach(nestedName => {
                const nestedPath = Path.join(path, nestedName);
                this.traversePathRecursively(nestedPath, worker, afterDirectory);
            });
    
            if (afterDirectory) {
                afterDirectory(path);
            }
        }
    }

    private log(message: string, necessary = false) {
        if (this.logger) {
            this.logger.error(message);
        } else if (necessary) {
            console.log(message);
        }
    }
}