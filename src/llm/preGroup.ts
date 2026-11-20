/**
 * Pure folder pre-grouping for very large changes. This only looks at paths:
 * it cannot tell whether two files are one intent, but it guarantees that every
 * later grouping request has a bounded file list.
 */
export function preGroup(paths: string[], maxFiles = 60): string[][] {
    const limit = Math.max(1, Math.floor(maxFiles));
    const root = createNode('');

    for (const filePath of new Set(paths)) {
        const parts = filePath.split('/').filter(part => part.length > 0);
        if (parts.length === 0) { continue; }
        let node = root;
        for (const part of parts.slice(0, -1)) {
            let child = node.directories.get(part);
            if (!child) {
                child = createNode(part);
                node.directories.set(part, child);
            }
            node = child;
        }
        node.files.push(filePath);
    }

    computeTotals(root);
    return collect(root, limit);
}

interface DirectoryNode {
    name: string;
    directories: Map<string, DirectoryNode>;
    files: string[];
    total: number;
}

function createNode(name: string): DirectoryNode {
    return { name, directories: new Map(), files: [], total: 0 };
}

function computeTotals(node: DirectoryNode): number {
    let total = node.files.length;
    for (const child of node.directories.values()) {
        total += computeTotals(child);
    }
    node.total = total;
    return total;
}

function collect(node: DirectoryNode, maxFiles: number): string[][] {
    if (node.total === 0) { return []; }
    if (node.total <= maxFiles) {
        return [allFiles(node).sort(compareText)];
    }

    const buckets: string[][] = [];
    const smallItems: Array<{ files: string[]; size: number }> = [];

    for (const name of [...node.directories.keys()].sort(compareText)) {
        const child = node.directories.get(name)!;
        if (child.total === 0) { continue; }
        if (child.total > maxFiles) {
            // A single child cannot be packed with anything else, so its own
            // recursive buckets come first.
            buckets.push(...collect(child, maxFiles));
        } else {
            smallItems.push({ files: allFiles(child), size: child.total });
        }
    }

    // Direct files follow every child directory; ordering by stem before the
    // full name keeps foo.ts, foo.test.ts and foo.css adjacent.
    for (const filePath of [...node.files].sort(compareFiles)) {
        smallItems.push({ files: [filePath], size: 1 });
    }

    let current: string[] = [];
    let currentSize = 0;
    for (const item of smallItems) {
        if (currentSize > 0 && currentSize + item.size > maxFiles) {
            buckets.push(current.sort(compareText));
            current = [];
            currentSize = 0;
        }
        current.push(...item.files);
        currentSize += item.size;
    }
    if (current.length > 0) {
        buckets.push(current.sort(compareText));
    }

    return buckets;
}

function allFiles(node: DirectoryNode): string[] {
    const files = [...node.files];
    for (const child of node.directories.values()) {
        files.push(...allFiles(child));
    }
    return files;
}

function compareFiles(left: string, right: string): number {
    const leftName = baseName(left);
    const rightName = baseName(right);
    const stem = compareText(stripExtension(leftName), stripExtension(rightName));
    if (stem !== 0) { return stem; }
    const name = compareText(leftName, rightName);
    return name !== 0 ? name : compareText(left, right);
}

function baseName(filePath: string): string {
    const index = filePath.lastIndexOf('/');
    return index === -1 ? filePath : filePath.slice(index + 1);
}

function stripExtension(fileName: string): string {
    const index = fileName.lastIndexOf('.');
    return index > 0 ? fileName.slice(0, index) : fileName;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
