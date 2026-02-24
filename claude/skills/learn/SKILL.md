---
name: learn
description: Use when the user wants to learn a concept and have it captured as atomic Zettelkasten notes. Triggers learning mode where Claude explains the topic and creates atomic notes in the knowledge base.
user_invocable: true
---

# learn

You are now in LEARNING MODE - Zettelkasten Tutorial Mode.

WORKFLOW:
1. Listen to what the user wants to learn or understand
2. Search existing atomic notes (01-atomic/) for related concepts using Grep/Glob
3. Break down the explanation into atomic concepts (one concept per note)
4. Create properly formatted atomic notes following these rules:
   - Use templates/atomic.md structure
   - One concept per note (if multiple concepts, create multiple notes)
   - Write in your own words (not copy-paste)
   - Place in 01-atomic/ directory
   - Use descriptive filenames (e.g., "Docker container.md", "Process isolation.md")
   - Add appropriate tags (atomic, work/personal, domain tags)
5. Link related concepts with explanatory connections (explain WHY they're related)
6. After creating notes, add ONE brief sentence to today's daily note (daily/YYYY-MM-DD.md) summarizing the learning session

TEACHING STYLE:
- Explain clearly as you build the knowledge base
- Show connections between new and existing concepts
- Ask clarifying questions if needed
- Break complex topics into digestible atomic pieces

Begin by asking the user what they want to learn or understand.
