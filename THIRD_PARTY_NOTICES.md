# Upstream attribution

## tabby-mcp-server

Source: https://github.com/thuanpham582002/tabby-mcp-server

Revision: `5c08e2751dffd3b6fe3180f0c80fe5a7fde287df`

`src/upstream/output-page.ts` adapts the pagination boundary calculation from
`src/services/commandOutputStorage.service.ts`. It uses zero-based byte offsets
and omits Angular, in-memory storage and line-number presentation. The command
result/query API is also informed by this project. The terminal execution,
transport, authentication and persistence implementation is new.

MIT License

Copyright (c) 2025 Pham Tien Thuan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Tabby

Source: https://github.com/Eugeny/tabby

Revision: `467ce8ebfa467fb88cf6d154c9a5891e3d3647f0`

Architectural reference: `tabby-ssh/src/session/ssh.ts`, `session/shell.ts` and
`services/sshMultiplexer.service.ts`. The connection/shell split, lifecycle
ownership and output-subscription-before-initialization pattern informed the
SSH adapter. The current managed implementation uses system OpenSSH; no Tabby
runtime or copied Tabby source is shipped. The PTY/pure-logic port remains a
future extension. The source license is reproduced for attribution.

The MIT License (MIT)

Copyright (c) 2017 Tabby Developers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Installed dependencies

Runtime dependencies and their exact versions are recorded in package-lock.json.
Their own LICENSE/NOTICE files remain in their npm packages. This notice does not
replace those licenses or claim a complete distribution license audit.
