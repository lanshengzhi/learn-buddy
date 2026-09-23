# Domain glossary: LearnBuddy

LearnBuddy is a single-household app with three independent experiences: Chat for AI conversations, Read for personal ebook reading, and Learn for text study. A Person's Chat history, Read books and reading progress, and Learn records are separate; a Person profile organizes records but does not make them private from other household members.

## Language

**Person (人)**: A member of the household whose Chat conversations and Read books and reading position are grouped under one profile. A Person identifies whose records are shown, not who can access them.

**Person profile (档案)**: The selection of a Person in the interface. It organizes records only; it is not an access boundary.

**Chat**: The text-conversation experience with an AI service. It has its own Conversation history and does not use Read content.

**Conversation (对话)**: A thread of text messages between a Person and the AI service.

**Conversation history (对话历史)**: A Person's collection of Conversations and their messages. It is not cross-Conversation recall of personal facts.

**Read**: The ebook-reading experience for a Person's books: shelf, chapters, and reading position. Language-learning tools are not part of Read; they live in Learn.

**Learn (学习)**: The text-study experience for pasted text: sentence segmentation, playback, lookup, and passage history. It does not open Books.

**Book (书)**: A digital book a Person has added to Read.

**Reading position (阅读位置)**: The place in a Book where a Person can resume reading.

## Terms we avoid

| Avoid | Use instead | Why |
|-------|-------------|-----|
| `Profile` as a domain entity | `Person` | A profile is only how a Person is selected; it is not a separate data owner. |
| `Memory` | `Conversation history` | The current model stores conversations; it does not recall personal facts across conversations. |
| `Reference` from Read into Chat | — | Chat and Read are independent and do not share content or context. |
| `agent` or `bot` as a product entity | `Chat` / `AI service` | Pi and model providers are runtime vocabulary, not household product entities. |
| Language-learning tools inside Read | `Learn` | Read is pure reading; playback, lookup, vocabulary marking, and paste-and-segment belong to Learn. |
