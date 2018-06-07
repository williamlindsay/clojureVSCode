Based on Andrey Lisin's VS Code Clojure extension.

- Fixes cljfmt saving bug where the file wouldn't save after the changes were applied
- Adds linters which run async on save: eastwood, bikeshed

Limitations:
- Eastwood and Bikeshed have hardcoded options at the moment
- Must save twice at the start for some reason to fix bug above
