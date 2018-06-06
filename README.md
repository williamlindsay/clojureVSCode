Based on Andrey Lisin's VS Code Clojure extension.

- Fixes cljfmt saving bug where the file wouldn't save after the changes were applied
- Adds linters which run async on save: eastwood

Limitations:
- Eastwood has hardcoded options at the moment
