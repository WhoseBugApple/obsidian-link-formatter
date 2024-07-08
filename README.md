# Link Util
this is a plugin for those who rename `root-dir` to `root-dir-1` then rename `root-dir-1` back to `root-dir`

## Re-create links according to current setting
### READ before use
if `Format links` is called

**for non-embedded-links, always updated** (non-embedded-links: sth like `[display-text](path)`)

**for embedded-links, display-text may be updated, path always updated** (embedded-link: sth like `![]()` , display-text: sth like `[display text](path)` , path-update: sth like `![](oldpath)` -> `![](newpath)`)

### how to execute
open the command palette (by default Ctrl+P) , 
execute `Format links` or `Report links`
