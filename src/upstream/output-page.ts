/**
 * Adapted from getPaginatedOutput in tabby-mcp-server's
 * src/services/commandOutputStorage.service.ts at
 * 5c08e2751dffd3b6fe3180f0c80fe5a7fde287df.
 * Copyright (c) 2025 Pham Tien Thuan, MIT; see THIRD_PARTY_NOTICES.md.
 * Changes: zero-based byte offsets; storage and Angular dependencies removed.
 */
export function pageBounds(totalBytes:number,cursor:number,maxBytes:number) {
  const startIdx=Math.max(0,cursor);
  const endIdx=Math.min(startIdx+maxBytes,totalBytes);
  return {startIdx,endIdx};
}
