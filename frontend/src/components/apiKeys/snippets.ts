/**
 * First calls with a new key, ready to paste.
 *
 * Each asks `/api/v1/api-keys/self`, which describes the key making the
 * request and changes nothing. Only the `.env` line holds the key itself: the
 * others read it from the environment, and the cURL one hands it to curl
 * through a header file written by a shell builtin, the way the API guide
 * does, so it never sits on a command line or in the process list.
 */
export type SnippetId = 'curl' | 'python' | 'javascript' | 'env'

export const SNIPPETS: { id: SnippetId; label: string }[] = [
    { id: 'curl', label: 'cURL' },
    { id: 'python', label: 'Python' },
    { id: 'javascript', label: 'JavaScript' },
    { id: 'env', label: '.env' },
]

export function snippet(id: SnippetId, token: string, origin: string): string {
    switch (id) {
        case 'env':
            return `API_KEY=${token}`
        case 'curl':
            return [
                '# API_KEY holds the key (see .env). printf is a builtin, so the key',
                '# stays off the command line and out of the process list.',
                'HDR=$(mktemp)',
                `printf 'Authorization: Bearer %s\\n' "$API_KEY" > "$HDR"`,
                `curl -sS ${origin}/api/v1/api-keys/self -H @"$HDR"`,
                'rm -f "$HDR"',
            ].join('\n')
        case 'python':
            return [
                'import os',
                'import httpx',
                '',
                'api = httpx.Client(',
                `    base_url="${origin}",`,
                '    headers={"Authorization": f"Bearer {os.environ[\'API_KEY\']}"},',
                '    timeout=30,',
                ')',
                'print(api.get("/api/v1/api-keys/self").json())',
            ].join('\n')
        case 'javascript':
            return [
                `const res = await fetch('${origin}/api/v1/api-keys/self', {`,
                '  headers: { Authorization: `Bearer ${process.env.API_KEY}` },',
                '})',
                'console.log(await res.json())',
            ].join('\n')
    }
}
