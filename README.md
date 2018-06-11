Based on Andrey Lisin's VS Code Clojure extension.

- Fixes cljfmt saving bug where the file wouldn't save after the changes were applied
- Adds linters which run async on save: eastwood, bikeshed
- Options for linters are now pulled from project.clj as explained in their respective repoes

Limitations:
- Must save twice at the start for some reason to fix bug above
- Only supports lein 2.7.1 at the moment
