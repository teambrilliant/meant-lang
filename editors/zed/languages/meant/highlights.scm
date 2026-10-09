(comment) @comment
((comment) @comment.doc
  (#match? @comment.doc "^#\\s*(SIM-)?EXPECT"))

(string) @string
(number) @number

(kw_decl) @keyword
(kw_other) @keyword
(kw_clause) @keyword
(actor_clause ["by" "to"] @keyword)
(actor_value) @constant
(unit) @type.builtin
(context_entity) @variable.special

(id) @label
(ref) @type
(deny_code) @constant
(marker) @attribute
(handle) @attribute
(vb_path) @link_uri

(operator) @operator
(punctuation) @punctuation.delimiter

(declaration name: (ref) @title)
(declaration name: (word) @title)
