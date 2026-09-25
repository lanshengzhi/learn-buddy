# Domain glossary: LearnBuddy

LearnBuddy is a single-household app with three independent experiences: Chat for AI conversations, Read for personal ebook reading, and Learn for text study. A Person's Chat history, Read books and reading progress, and Learn records are separate; a Person profile organizes records but does not make them private from other household members.

## Language

**Person (人)**: A member of the household whose Chat conversations and Read books and reading position are grouped under one profile. A Person identifies whose records are shown, not who can access them.

**Person profile (档案)**: The selection of a Person in the interface. It organizes records only; it is not an access boundary.

**Chat**: The text-conversation experience with an AI service. It has its own Conversation history and does not use Read content.

**Conversation (对话)**: A thread of text messages between a Person and the AI service.

**Conversation history (对话历史)**: A Person's collection of Conversations and their messages. It is not cross-Conversation recall of personal facts.

**Read**: The ebook-reading experience for a Person's books: shelf, chapters, reading position, read-aloud, word lookup, and Book AI. It does not study text: paste-and-segment, single-sentence looping, and passage history live in Learn.

**Learn (学习)**: The text-study experience for pasted text: sentence segmentation, per-sentence listening with looping, word lookup, and passage history. It does not open Books.

**BookConversation (书本对话)**: A Read-scoped conversation between a Person and the AI service about one Book. It is separate from ordinary Chat and records the Book context used for each turn.

**BookContext (书本上下文)**: The bounded, Book-scoped material used for one Book AI request or turn. It is tied to a Book and its content version; it is not global memory.

**ContextScope (上下文范围)**: The explicit extent of a BookContext: a sentence, a selected range, a chapter, or the whole Book.

**StudyJob (学习任务)**: An asynchronous request to generate a learning artifact for an explicit Book and ContextScope. A StudyJob is not the Book, the BookConversation, or the artifact itself.

**StudyArtifact (学习产物)**: A locally retained report, mind map, flashcard set, or audio explanation produced for a Person and Book. It is a generated output, not a Reading position or a formal learning record.

**NotebookRef (远端笔记本引用)**: A non-authoritative reference from a local Book to a remote notebook resource and its source. The local Book remains the authority for reading data.

**Book (书)**: A digital book a Person has added to Read.

**Reading position (阅读位置)**: The place in a Book where a Person can resume reading.

## Terms we avoid

| Avoid | Use instead | Why |
|-------|-------------|-----|
| `Profile` as a domain entity | `Person` | A profile is only how a Person is selected; it is not a separate data owner. |
| `Memory` | `Conversation history` | The current model stores conversations; it does not recall personal facts across conversations. |
| `Reference` from Read into ordinary Chat | `BookConversation` | Ordinary Chat and Read are independent; Book AI has its own Book-scoped context. |
| `Notebook` / `NotebookLM Notebook` as a Book | `Book` / `NotebookRef` | A remote notebook is a generated-resource reference, not the local reading authority. |
| `Note` as a generated report or mind map | `StudyArtifact` | Generated outputs are artifacts, not reading notes or conversation messages. |
| `agent` or `bot` as a product entity | `Chat` / `AI service` | Pi and model providers are runtime vocabulary, not household product entities. |
| Study tools inside Read | `Learn` | Read offers reading affordances (read-aloud, word lookup); paste-and-segment, single-sentence looping, and passage history belong to Learn. |
