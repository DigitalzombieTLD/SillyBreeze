export function splitParagraphs(text) {
    return String(text)
        .replace(/\r\n?/g, '\n')
        .split(/\n[ \t]*\n+/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean);
}

export function parseInstructionParagraphs(text, enabled) {
    if (!enabled) {
        return [{ text: String(text) }];
    }

    return splitParagraphs(text).map(paragraph => {
        const match = paragraph.match(/^<instructions="([^"]*)">(?:[ \t]*\r?\n?|\s+)?/);
        const instruction = match?.[1]?.trim();
        const content = match ? paragraph.slice(match[0].length).trim() : paragraph;
        return instruction ? { text: content, instruction } : { text: content };
    }).filter(paragraph => paragraph.text);
}

export function extractQuotedAndParenthetical(text) {
    const output = [];
    const selection = /"(?:\\.|[^"\\])*"|“[^”]*”|«[^»]*»|「[^」]*」|『[^』]*』|\([^()\r\n]+\)/g;

    for (const paragraph of splitParagraphs(text)) {
        const instructionTag = paragraph.match(/^(<instructions="[^"]*">)(?:[ \t]*\r?\n?|\s+)?/);
        const prefix = instructionTag?.[0] ?? '';
        const matches = paragraph.slice(prefix.length).match(selection);
        if (matches) {
            output.push(`${prefix}${matches.join(' ')}`);
        }
    }

    return output.join('\n\n');
}
