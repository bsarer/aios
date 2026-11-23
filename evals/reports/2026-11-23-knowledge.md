# Knowledge bake-off, 2026-11-23


Run on Baris's computer from the bake-off branch (commit 82f0742), before K5: every model got the old extraction prompt, and the checks grade the raw answers. Picked for the knowledge base's cloud model: `openai/gpt-6-luna` (providers.json `knowledgeModel`).
Invented emails, chat and calendar only. Every model gets the knowledge base's own extraction request, unchanged. 1 run.

| Model | Checks passed (answered items) | Guesses stated as facts | Real facts kept | Failed calls | Avg time | Cost |
|---|---|---|---|---|---|---|
| `local qwen3:1.7b` | 11 of 11 | 0 of 8 traps | 3 of 3 | 3 | 60.6 s | $0.0000 |
| `anthropic/claude-haiku-5.5` | 13 of 16 | 3 of 12 traps | 4 of 4 | 0 | 2.4 s | $0.0034 |
| `openai/gpt-6-luna` | 15 of 16 | 1 of 12 traps | 4 of 4 | 0 | 2.5 s | $0.0027 |
| `deepseek/deepseek-v4.1-flash-1017` | 13 of 14 | 1 of 11 traps | 3 of 3 | 1 | 5.6 s | $0.0020 |
| `moonshotai/kimi-k3.1-pro` | 8 of 9 | 1 of 7 traps | 2 of 2 | 4 | 10.7 s | $0.0608 |
| `z-ai/glm-5.3` | 12 of 14 | 2 of 10 traps | 4 of 4 | 2 | 9.7 s | $0.0278 |
| `qwen/qwen3.8-27b` | 6 of 7 | 1 of 6 traps | 1 of 1 | 5 | 14.6 s | $0.0085 |

## shared-surname

Someone with the same surname writes about a book. Nothing says how they are related.

**`local qwen3:1.7b`**: ✅ no family label for Selin; ✅ keeps the book drop-off

- [recent] Received the book from Selin Arslan on 2026-10-02
- Book (project): Received the book from Selin Arslan on 2026-10-02
- aios.test (org): Received the book from Selin Arslan on 2026-10-02

**`anthropic/claude-haiku-5.5`**: ❌ no family label for Selin (“[people] Selin Arslan: sibling or relative of Deniz (shares surname); returning a book Deniz lent her in the summer, offering to drop it off on Saturday afternoon.”); ✅ keeps the book drop-off

- [people] Selin Arslan: sibling or relative of Deniz (shares surname); returning a book Deniz lent her in the summer, offering to drop it off on Saturday afternoon.
- [commitments] Selin Arslan is dropping off the book Deniz lent her, planned for Saturday afternoon after 2 Oct 2026.
- [recent] Selin Arslan said she finished the book Deniz lent her and offered to return it on Saturday afternoon.
- Selin Arslan (person): Finished reading the book Deniz lent her in the summer.
- Selin Arslan (person): Offered to drop the book off on Saturday afternoon if Deniz is home.

**`openai/gpt-6-luna`**: ✅ no family label for Selin; ✅ keeps the book drop-off

- [people] Selin Arslan: returning a book Deniz lent her in the summer; offered to drop it off on 3 Oct 2026 if Deniz is home.
- [commitments] Waiting for Selin Arslan to return the book on 3 Oct 2026, if Deniz is home.
- Selin Arslan (person): Finished the book Deniz lent her in the summer and offered to drop it off on 3 Oct 2026 if Deniz is home.

**`deepseek/deepseek-v4.1-flash-1017`**: ✅ no family label for Selin; ✅ keeps the book drop-off

- [people] Selin Arslan: borrowed a book from Deniz in the summer and can return it on Saturday afternoon, 3 Oct 2026.
- [commitments] Be home on Saturday afternoon, 3 Oct 2026, if possible, to receive the book from Selin Arslan.
- [interests] Lends books to friends, including a book lent to Selin Arslan in summer 2026.
- [recent] Selin Arslan finished the book Deniz lent her and offered to drop it off on 3 Oct 2026.
- Selin Arslan (person): Finished the book Deniz lent her in summer 2026.
- Selin Arslan (person): Can drop the book off on Saturday afternoon, 3 Oct 2026, if Deniz is home.

**`moonshotai/kimi-k3.1-pro`**: ❌ no family label for Selin (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”); ❌ keeps the book drop-off (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

**`z-ai/glm-5.3`**: ✅ no family label for Selin; ✅ keeps the book drop-off

- [people] Selin Arslan: borrowed a book from Deniz over the summer; finished it and offered to drop it off on Saturday afternoon, 3 Oct 2026.
- [commitments] Waiting for Selin Arslan to return the lent book; she proposed dropping it off on Saturday afternoon, 3 Oct 2026.
- [interests] Owns books and lends them out; lent one to Selin Arslan during the summer.
- [recent] Selin Arslan finished the book Deniz lent her and offered to return it on Saturday afternoon, 3 Oct 2026.
- Selin Arslan (person): Borrowed a book from Deniz Arslan in the summer.
- Selin Arslan (person): Finished reading the book by 2 Oct 2026.
- Selin Arslan (person): Offered to drop the book off on Saturday afternoon, 3 Oct 2026.

**`qwen/qwen3.8-27b`**: ✅ no family label for Selin; ✅ keeps the book drop-off

- [people] Selin Arslan: borrowed a book from Deniz in summer and offered to return it on Saturday afternoon.
- [recent] Selin Arslan said she could drop off the book on 3 Oct afternoon if Deniz is home.
- Selin Arslan (person): Finished the book Deniz Arslan lent her in summer.
- Selin Arslan (person): Offered to drop the book off on 3 Oct afternoon.

## stated-sister

The user writes "my sister Ece" in their own email. This relationship is stated.

**`local qwen3:1.7b`**: ❌ records Ece as sister (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”); ❌ no relationship invented for Hakan (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

**`anthropic/claude-haiku-5.5`**: ✅ records Ece as sister; ✅ no relationship invented for Hakan

- [people] Hakan Demir: friend of Deniz; Deniz declined his Saturday plans because of airport pickup.
- [people] Ece Arslan: sister of Deniz; flying in from Berlin on Saturday morning, 10 Oct 2026.
- [commitments] Pick up sister Ece at the airport on Saturday morning, 10 Oct 2026.
- [recent] Declined Hakan Demir's Saturday plans in an email sent 5 Oct 2026, citing airport pickup.
- Hakan Demir (person): Was asked by Deniz to be told Saturday plans are off, email sent 5 Oct 2026.
- Ece Arslan (person): Flying in from Berlin on Saturday morning, 10 Oct 2026; Deniz is picking her up at the airport.

**`openai/gpt-6-luna`**: ✅ records Ece as sister; ✅ no relationship invented for Hakan

- [people] Ece: Deniz Arslan’s sister; flying in from Berlin on 10 Oct 2026, and Deniz is picking her up at the airport.
- [people] Hakan Demir: Deniz told him they could not make it on Saturday, 10 Oct 2026.
- [commitments] Pick up sister Ece at the airport on 10 Oct 2026.
- [recent] Told Hakan Demir they could not make it on 10 Oct 2026 because Ece was arriving from Berlin.
- Ece (person): Deniz Arslan’s sister is flying in from Berlin on 10 Oct 2026.
- Ece (person): Deniz is picking her up at the airport that morning.
- Ece (person) links: Hakan Demir
- Hakan Demir (person): Deniz told him they could not make it on Saturday, 10 Oct 2026.
- Hakan Demir (person) links: Ece

**`deepseek/deepseek-v4.1-flash-1017`**: ❌ records Ece as sister (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”); ❌ no relationship invented for Hakan (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

**`moonshotai/kimi-k3.1-pro`**: ❌ records Ece as sister (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”); ❌ no relationship invented for Hakan (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

**`z-ai/glm-5.3`**: ✅ records Ece as sister; ❌ no relationship invented for Hakan (“[recent] Told Hakan Demir on 5 Oct 2026 he cannot make Saturday because his sister Ece arrives from Berlin that morning.”)

- [people] Hakan Demir: had plans with Deniz for Saturday, which Deniz cancelled on 5 Oct 2026.
- [people] Ece: Deniz's sister; flying in from Berlin on the morning of Saturday 10 Oct 2026.
- [commitments] Picking his sister Ece up at the airport on the morning of Saturday 10 Oct 2026.
- [commitments] Cancelled the plans with Hakan Demir for Saturday 10 Oct 2026.
- [recent] Told Hakan Demir on 5 Oct 2026 he cannot make Saturday because his sister Ece arrives from Berlin that morning.
- Hakan Demir (person): Had plans with Deniz for Saturday 10 Oct 2026.
- Hakan Demir (person): Was told by Deniz on 5 Oct 2026 that he cannot make it on Saturday.
- Hakan Demir (person) links: Ece
- Ece (person): Is Deniz's sister and lives in or travels from Berlin.
- Ece (person): Is flying in from Berlin on the morning of Saturday 10 Oct 2026.
- Ece (person): Deniz is picking her up at the airport on arrival.
- Ece (person) links: Hakan Demir

**`qwen/qwen3.8-27b`**: ❌ records Ece as sister (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”); ❌ no relationship invented for Hakan (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

## hotel-booking

A hotel confirmation for a stay in Jacksonville. A trip is not a liking.

**`local qwen3:1.7b`**: ✅ no liking for Jacksonville

- [recent] Booked flights to Izmir for 3 Dec.
- Deniz Arslan (person): Asked for the signed lease by 20 Nov.
- Deniz Arslan (person) links: Riverside Suites
- Flights to Izmir (project): Booked flights to Izmir for 3 Dec.
- Flights to Izmir (project) links: Deniz Arslan

**`anthropic/claude-haiku-5.5`**: ✅ no liking for Jacksonville

- [recent] Booked a King non-smoking room at Riverside Suites Jacksonville for 3 to 5 October 2026.
- [commitments] Stay at Riverside Suites Jacksonville checks in on 3 October 2026 and checks out on 5 October 2026.
- [interests] Travelling to Jacksonville in early October 2026.
- Riverside Suites Jacksonville (org): Confirmed Deniz Arslan's reservation for a King non-smoking room, check-in 3 October 2026, check-out 5 October 2026.
- Riverside Suites Jacksonville (org) links: Deniz Arslan

**`openai/gpt-6-luna`**: ✅ no liking for Jacksonville

- [recent] Booked a King, non-smoking room at Riverside Suites Jacksonville for 3–5 October 2026.
- Riverside Suites Jacksonville (org): Confirmed Deniz Arslan’s reservation for a King, non-smoking room from 3 October 2026 to 5 October 2026.

**`deepseek/deepseek-v4.1-flash-1017`**: ✅ no liking for Jacksonville

- [recent] Booked a stay at Riverside Suites Jacksonville from 3 October to 5 October 2026 in a king non-smoking room.
- [commitments] Check in at Riverside Suites Jacksonville on 3 October 2026 and check out on 5 October 2026.
- Riverside Suites Jacksonville (org): Confirmed Deniz Arslan's reservation with check-in on 3 October 2026 and check-out on 5 October 2026.
- Riverside Suites Jacksonville (org): Assigned Deniz Arslan a king, non-smoking room for the stay.

**`moonshotai/kimi-k3.1-pro`**: ✅ no liking for Jacksonville

- [recent] Booked a King, non-smoking room at Riverside Suites Jacksonville, checking in 3 October 2026 and checking out 5 October 2026.

**`z-ai/glm-5.3`**: ❌ no liking for Jacksonville (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

**`qwen/qwen3.8-27b`**: ✅ no liking for Jacksonville

- [recent] Booked a King non-smoking room at Riverside Suites Jacksonville for 3-5 October 2026.
- [commitments] Check in at Riverside Suites Jacksonville on 3 October 2026 and check out on 5 October 2026.
- Riverside Suites (org): Confirmed a King non-smoking room for Deniz Arslan for 3-5 October 2026.

## stranger-invite

A calendar with one meeting that someone at another company set up. Nothing says they work together.

**`local qwen3:1.7b`**: ❌ Olena not called a colleague (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”); ❌ Ece not given a relationship from the calendar (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

**`anthropic/claude-haiku-5.5`**: ✅ Olena not called a colleague; ✅ Ece not given a relationship from the calendar

- [work] Had an intro call with Olena Marsh about Halcyon Labs on Tue 6 Oct at 14:00.
- [people] Olena Marsh: contact at Halcyon Labs; Deniz had an intro call with her on 6 Oct.
- [people] Ece: visiting Deniz on Sat 17 Oct, all day.
- [commitments] Dentist appointment at Bayview Dental on Thu 15 Oct at 10:00.
- [interests] Uses a dentist at Bayview Dental for appointments.
- [recent] Had an intro call with Halcyon Labs and Olena Marsh on 6 Oct.
- Halcyon Labs (org): Had an intro call with Deniz and Olena Marsh on Tue 6 Oct at 14:00.
- Halcyon Labs (org) links: Olena Marsh
- Olena Marsh (person): Took part in an intro call with Deniz about Halcyon Labs on Tue 6 Oct at 14:00.
- Olena Marsh (person) links: Halcyon Labs

**`openai/gpt-6-luna`**: ✅ Olena not called a colleague; ✅ Ece not given a relationship from the calendar

- [people] Olena Marsh: scheduled for an intro call with Deniz and Halcyon Labs on Tue 6 Oct.
- [people] Ece: visiting Deniz on Sat 17 Oct.
- [work] Has an intro call with Halcyon Labs and Olena Marsh scheduled for Tue 6 Oct.
- [commitments] Has a dentist appointment at Bayview Dental on Thu 15 Oct at 10:00.
- [commitments] Ece is visiting on Sat 17 Oct.
- Olena Marsh (person): Scheduled for an intro call with Deniz and Halcyon Labs on Tue 6 Oct.
- Olena Marsh (person) links: Halcyon Labs
- Ece (person): Visiting Deniz on Sat 17 Oct.
- Halcyon Labs (org): Scheduled to have an intro call with Deniz and Olena Marsh on Tue 6 Oct.
- Halcyon Labs (org) links: Olena Marsh
- Bayview Dental (org): Deniz has a dentist appointment there on Thu 15 Oct at 10:00.

**`deepseek/deepseek-v4.1-flash-1017`**: ✅ Olena not called a colleague; ✅ Ece not given a relationship from the calendar

- [people] Olena Marsh: contact at Halcyon Labs; had an intro call with Deniz on 6 Oct.
- [people] Ece: visiting Deniz on 17 Oct.
- [work] Took an intro call with Halcyon Labs and Olena Marsh on 6 Oct.
- [commitments] Has a dentist appointment at Bayview Dental on 15 Oct at 10:00.
- [recent] Held an intro call with Halcyon Labs and Olena Marsh on 6 Oct.
- Olena Marsh (person): Took part in an intro call with Deniz and Halcyon Labs on 6 Oct.
- Olena Marsh (person) links: Halcyon Labs
- Halcyon Labs (org): Had an intro call with Deniz and Olena Marsh on 6 Oct.
- Halcyon Labs (org) links: Olena Marsh
- Ece (person): Is visiting Deniz on 17 Oct.

**`moonshotai/kimi-k3.1-pro`**: ❌ Olena not called a colleague (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”); ❌ Ece not given a relationship from the calendar (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

**`z-ai/glm-5.3`**: ✅ Olena not called a colleague; ✅ Ece not given a relationship from the calendar

- [people] Olena Marsh: contact at Halcyon Labs; had an intro call with Deniz on 6 Oct at 14:00
- [people] Ece: visitor spending the whole day with Deniz on Sat 17 Oct
- [work] Had an intro call with Halcyon Labs, represented by Olena Marsh, on 6 Oct
- [commitments] Dentist appointment at Bayview Dental on Thu 15 Oct at 10:00
- [recent] Held an intro call with Olena Marsh of Halcyon Labs on 6 Oct
- Olena Marsh (person): Joined an intro call with Deniz on 6 Oct at 14:00.
- Olena Marsh (person): Represents Halcyon Labs in dealings with Deniz.
- Olena Marsh (person) links: Halcyon Labs
- Halcyon Labs (org): Held an intro call with Deniz and Olena Marsh on 6 Oct.
- Halcyon Labs (org) links: Olena Marsh
- Ece (person): Visiting Deniz all day on Sat 17 Oct.

**`qwen/qwen3.8-27b`**: ❌ Olena not called a colleague (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”); ❌ Ece not given a relationship from the calendar (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

## friend-city

A friend loves the city they moved to. The liking is the friend's, not the user's.

**`local qwen3:1.7b`**: ✅ no liking for Austin on the user; ✅ no family label for Jonah

- [people] Jonah Pike: friend; suggesting visit in spring
- [interests] Eats out in Austin
- [recent] Booked flights to Austin for 2026-10-08
- Jonah Pike (person): Suggested visit to Austin in spring
- Settled in Austin (project): Confirmed move to Austin
- Austin (org): Location of new residence

**`anthropic/claude-haiku-5.5`**: ❌ no liking for Austin on the user (“[interests] Jonah Pike's move to Austin suggests Deniz may be interested in visiting Austin in spring 2027.”); ✅ no family label for Jonah

- [people] Jonah Pike: friend who has just moved to Austin and invited Deniz to visit in the spring.
- [interests] Jonah Pike's move to Austin suggests Deniz may be interested in visiting Austin in spring 2027.
- [recent] Received an email from Jonah Pike on 8 Oct 2026 saying they have settled into Austin.
- Jonah Pike (person): Has settled in Austin as of 8 Oct 2026, and says the food and weather there are great.
- Jonah Pike (person): Suggested that Deniz visit Austin in the spring.

**`openai/gpt-6-luna`**: ✅ no liking for Austin on the user; ✅ no family label for Jonah

- [people] Jonah Pike: invited Deniz to visit him in Austin in spring and says he has settled there.
- [recent] Received Jonah Pike’s invitation to visit Austin in spring.
- Jonah Pike (person): He says he is settled in Austin.
- Jonah Pike (person): He invited Deniz to visit him in Austin in spring.
- Jonah Pike (person): He says he loves Austin’s food and weather.

**`deepseek/deepseek-v4.1-flash-1017`**: ✅ no liking for Austin on the user; ✅ no family label for Jonah

- [people] Jonah Pike: friend who has moved to Austin, Texas, and says he loves it there.
- [recent] Heard from Jonah Pike that he is settled in Austin and was invited to visit in the spring.
- Jonah Pike (person): Moved to Austin and is settled there as of 8 Oct 2026.
- Jonah Pike (person): Likes Austin's food and weather, which he says is better than before.
- Jonah Pike (person): Suggested Deniz visit him in Austin in the spring.

**`moonshotai/kimi-k3.1-pro`**: ✅ no liking for Austin on the user; ✅ no family label for Jonah

- [people] Jonah Pike: contact who has settled in Austin; invited Deniz to visit in the spring.
- [recent] Received an invitation from Jonah Pike on 8 Oct 2026 to visit Austin in the spring.
- Jonah Pike (person): Wrote to Deniz on 8 Oct 2026 after settling in Austin.
- Jonah Pike (person): Loves Austin and praised its food and weather.
- Jonah Pike (person): Invited Deniz to visit Austin in the spring.

**`z-ai/glm-5.3`**: ✅ no liking for Austin on the user; ✅ no family label for Jonah

- [people] Jonah Pike: friend who moved to Austin and invited Deniz to visit in the spring.
- [recent] Jonah Pike told Deniz he has settled into Austin and suggested a spring visit.
- Jonah Pike (person): Moved to Austin and settled in there by 8 Oct 2026.
- Jonah Pike (person): Enjoys the food and better weather in Austin.
- Jonah Pike (person): Invited Deniz Arslan to visit Austin in the spring.

**`qwen/qwen3.8-27b`**: ✅ no liking for Austin on the user; ✅ no family label for Jonah

- [people] Jonah Pike: contact who has moved to Austin and invited Deniz to visit in spring.
- [recent] Jonah Pike told Deniz they are settled in Austin and suggested a spring visit.
- Jonah Pike (person): Settled in Austin by 8 Oct 2026.
- Jonah Pike (person): Invited Deniz to visit in spring.

## stated-interest

The user says in their own email that they love Saturday tennis. This interest is stated.

**`local qwen3:1.7b`**: ✅ records the tennis; ✅ no relationship invented for Priya

- [people] Deniz Arslan: colleague; discussing tennis schedule with Priya Nair
- [interests] Plays tennis on Saturdays
- [recent] Sent email to Priya Nair on 2026-10-09
- Deniz Arslan (person): Sent email to Priya Nair on 2026-10-09
- Priya Nair (person): Received email from Deniz Arslan on 2026-10-09

**`anthropic/claude-haiku-5.5`**: ✅ records the tennis; ✅ no relationship invented for Priya

- [people] Priya Nair: friend; Deniz proposed Sunday brunch instead of Saturday morning.
- [interests] Plays tennis every Saturday and really enjoys it.
- [commitments] Offered Priya Nair a Sunday brunch instead of Saturday morning, pending her reply.
- [recent] Declined a Saturday morning plan with Priya Nair on 9 Oct 2026 because of tennis.
- Priya Nair (person): Was asked by Deniz Arslan to meet for Sunday brunch instead of Saturday morning, as of 9 Oct 2026.

**`openai/gpt-6-luna`**: ✅ records the tennis; ✅ no relationship invented for Priya

- [people] Priya Nair: discussing whether to have brunch on Sunday, 11 Oct 2026.
- [interests] Plays tennis every Saturday and really loves it.
- [recent] Said Sunday brunch with Priya Nair works on 11 Oct 2026.
- Priya Nair (person): Discussed whether to have brunch with Deniz on Sunday, 11 Oct 2026.

**`deepseek/deepseek-v4.1-flash-1017`**: ✅ records the tennis; ✅ no relationship invented for Priya

- [people] Priya Nair: friend or acquaintance; arranging weekend plans and Sunday brunch on 11 Oct.
- [commitments] Agreed to Sunday brunch with Priya Nair on 11 Oct.
- [interests] Plays tennis every Saturday and really loves it.
- [recent] Told Priya Nair on 9 Oct that Saturday morning was out but Sunday brunch worked.
- Priya Nair (person): Discussed weekend plans with Deniz Arslan on 9 Oct; Deniz said Sunday brunch works but Saturday morning does not.
- Priya Nair (person): Deniz Arslan plays tennis every Saturday morning.

**`moonshotai/kimi-k3.1-pro`**: ✅ records the tennis; ✅ no relationship invented for Priya

- [people] Priya Nair: contact; discussing weekend availability and a possible Sunday brunch on 11 Oct 2026.
- [commitments] Suggested Sunday brunch with Priya Nair on 11 Oct 2026; Saturday morning, 10 Oct 2026, is unavailable.
- [interests] Plays tennis every Saturday and loves it.
- [recent] Told Priya Nair on 9 Oct 2026 that Saturday morning was unavailable and suggested Sunday brunch instead.
- Priya Nair (person): Priya Nair is discussing weekend plans with Deniz Arslan.
- Priya Nair (person): Deniz Arslan suggested Sunday brunch on 11 Oct 2026 after saying Saturday morning was unavailable.

**`z-ai/glm-5.3`**: ✅ records the tennis; ✅ no relationship invented for Priya

- [people] Priya Nair: someone arranging weekend plans with Deniz; Deniz proposed Sunday brunch instead of Saturday morning on 9 Oct 2026.
- [commitments] Waiting for Priya Nair to confirm Sunday brunch after proposing it on 9 Oct 2026.
- [interests] Plays tennis every Saturday morning and loves it.
- [recent] Told Priya Nair on 9 Oct 2026 that Saturday morning is out due to tennis and suggested Sunday brunch.
- Priya Nair (person): Arranging weekend plans with Deniz Arslan.
- Priya Nair (person): Deniz told her on 9 Oct 2026 that Saturday morning does not work but Sunday brunch does.

**`qwen/qwen3.8-27b`**: ❌ records the tennis (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”); ❌ no relationship invented for Priya (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

## chat-echo

Astra repeats a guess ("your sister Buket") in chat. The user never said it.

**`local qwen3:1.7b`**: ❌ the assistant's guess is not stored (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

**`anthropic/claude-haiku-5.5`**: ❌ the assistant's guess is not stored (“[people] Buket Arslan: sister; Deniz agreed that Thursday works for a meeting or plan with her.”)

- [people] Buket Arslan: sister; Deniz agreed that Thursday works for a meeting or plan with her.
- [commitments] Meet Buket Arslan on Thursday, as agreed in a reply Deniz sent.
- [recent] Sent Buket Arslan a reply saying Thursday works for them.
- Buket Arslan (person): Deniz's sister.
- Buket Arslan (person): Deniz told her in a reply that Thursday works.

**`openai/gpt-6-luna`**: ❌ the assistant's guess is not stored (“[people] Buket Arslan: sister; Deniz said Thursday works for their plans.”)

- [people] Buket Arslan: sister; Deniz said Thursday works for their plans.
- [recent] Agreed that Thursday works for plans with sister Buket Arslan.
- Buket Arslan (person): Deniz said Thursday works for their plans.

**`deepseek/deepseek-v4.1-flash-1017`**: ❌ the assistant's guess is not stored (“[people] Buket Arslan: Deniz's sister; they agreed to meet on Thursday.”)

- [people] Buket Arslan: Deniz's sister; they agreed to meet on Thursday.
- [commitments] Meet Buket Arslan on Thursday.
- [recent] Sent Buket Arslan a reply saying Thursday is fine.
- Buket Arslan (person): Deniz's sister; Deniz confirmed that Thursday works for their meeting.

**`moonshotai/kimi-k3.1-pro`**: ❌ the assistant's guess is not stored (“[people] Buket Arslan: sister; arranging to see each other Thursday, which Deniz confirmed works.”)

- [people] Buket Arslan: sister; arranging to see each other Thursday, which Deniz confirmed works.
- [commitments] See Buket Arslan on Thursday.
- [recent] Sent Buket Arslan a reply confirming Thursday works and saying they would see each other then.
- Buket Arslan (person): Buket Arslan is Deniz Arslan's sister.
- Buket Arslan (person): Deniz Arslan sent her a reply confirming Thursday works and saying they would see each other then.

**`z-ai/glm-5.3`**: ❌ the assistant's guess is not stored (“[people] Buket Arslan: sister; Deniz confirmed Thursday works for their meeting and sent her a reply saying so.”)

- [people] Buket Arslan: sister; Deniz confirmed Thursday works for their meeting and sent her a reply saying so.
- [commitments] Meet sister Buket Arslan on Thursday, as confirmed in the sent reply.
- [recent] Sent sister Buket Arslan a reply confirming Thursday works for their meeting.
- Buket Arslan (person): Deniz Arslan's sister.
- Buket Arslan (person): Received a reply from Deniz Arslan confirming Thursday works for their meeting.
- Buket Arslan (person): The reply ended with see you then.

**`qwen/qwen3.8-27b`**: ❌ the assistant's guess is not stored (“[people] Buket Arslan: sister; Deniz confirmed Thursday works for their plans.”)

- [people] Buket Arslan: sister; Deniz confirmed Thursday works for their plans.
- [commitments] Agreed to meet Buket Arslan on Thursday.
- [recent] Sent Buket Arslan a message confirming Thursday works.
- Buket Arslan (person): Is Deniz Arslan's sister.
- Buket Arslan (person): Deniz confirmed Thursday works for their plans.

## vendor-signature

A project manager at another company writes about a contract. He is a vendor, not a colleague.

**`local qwen3:1.7b`**: ✅ Mark not called a colleague; ✅ keeps the renovation contract

- [people] Mark Tellez: project manager; discussing kitchen renovation contract
- [work] Acme Build: employer; discussing kitchen renovation contract
- [commitments] Send the signed lease by 2 November
- [recent] Booked email to Deniz Arslan on 12 Oct 2026
- Mark Tellez (person): Discussed the kitchen renovation contract with Deniz Arslan
- Acme Build (org): Employer; discussing kitchen renovation contract
- Kitchen renovation contract (project): Attached; total $18,400; start date 2 November once signed

**`anthropic/claude-haiku-5.5`**: ✅ Mark not called a colleague; ✅ keeps the renovation contract

- [people] Mark Tellez: project manager at Acme Build; sent Deniz the revised kitchen renovation contract totalling $18,400.
- [work] Acme Build is handling a kitchen renovation for Deniz, with work starting 2 November once the contract is signed.
- [commitments] Needs to review and sign the revised kitchen renovation contract from Acme Build before work can start on 2 November.
- [recent] Received the revised kitchen renovation contract from Mark Tellez on 12 October 2026.
- Mark Tellez (person): Project manager at Acme Build.
- Mark Tellez (person): Sent the revised kitchen renovation contract on 12 October 2026, totalling $18,400, with start on 2 November once signed.
- Mark Tellez (person) links: Acme Build, Kitchen renovation
- Kitchen renovation (project): Revised contract from Acme Build totals $18,400.
- Kitchen renovation (project): Work can start on 2 November once the contract is signed.
- Kitchen renovation (project) links: Acme Build, Mark Tellez
- Acme Build (org): Contractor for the kitchen renovation; sent the revised contract on 12 October 2026.
- Acme Build (org) links: Mark Tellez, Kitchen renovation

**`openai/gpt-6-luna`**: ✅ Mark not called a colleague; ✅ keeps the renovation contract

- [people] Mark Tellez: project manager at Acme Build; sent Deniz Arslan a revised kitchen renovation contract.
- [work] Working with Acme Build on a kitchen renovation contract totaling $18,400.
- [recent] Received a revised kitchen renovation contract from Mark Tellez for $18,400; work can start on 2 November once it is signed.
- Mark Tellez (person): Project manager at Acme Build who sent Deniz Arslan the revised kitchen renovation contract on 12 October 2026.
- Mark Tellez (person) links: Kitchen renovation, Acme Build
- Kitchen renovation (project): The revised contract totals $18,400.
- Kitchen renovation (project): Work can start on 2 November once the contract is signed.
- Kitchen renovation (project) links: Mark Tellez, Acme Build
- Acme Build (org): Mark Tellez is its project manager and sent the revised kitchen renovation contract.
- Acme Build (org) links: Mark Tellez, Kitchen renovation

**`deepseek/deepseek-v4.1-flash-1017`**: ✅ Mark not called a colleague; ✅ keeps the renovation contract

- [people] Mark Tellez: project manager at Acme Build; handling the contract for Deniz's kitchen renovation.
- [commitments] Sign and return the revised Acme Build kitchen renovation contract so work can start on 2 November.
- [commitments] Review the revised kitchen renovation contract totalling $18,400.
- [recent] Received a revised kitchen renovation contract for $18,400 from Mark Tellez at Acme Build on 12 Oct 2026.
- Mark Tellez (person): Project Manager at Acme Build.
- Mark Tellez (person): Sent Deniz a revised kitchen renovation contract on 12 Oct 2026.
- Mark Tellez (person): Said work can start on 2 November once the contract is signed.
- Mark Tellez (person) links: Acme Build, Kitchen renovation
- Acme Build (org): Contractor for Deniz's kitchen renovation, quoted at $18,400.
- Acme Build (org) links: Mark Tellez, Kitchen renovation
- Kitchen renovation (project): Total cost of $18,400 in the revised contract.
- Kitchen renovation (project): Scheduled to start on 2 November once the contract is signed.
- Kitchen renovation (project): Contract was revised and sent on 12 Oct 2026.
- Kitchen renovation (project) links: Mark Tellez, Acme Build

**`moonshotai/kimi-k3.1-pro`**: ✅ Mark not called a colleague; ✅ keeps the renovation contract

- [people] Mark Tellez: project manager at Acme Build; handling Deniz's revised kitchen renovation contract totaling $18,400.
- [commitments] Sign the revised kitchen renovation contract before Acme Build can start on 2 November; the total is $18,400.
- [recent] Received the revised kitchen renovation contract from Mark Tellez on 2026-10-12.
- Mark Tellez (person): Mark Tellez is a project manager at Acme Build.
- Mark Tellez (person): Mark Tellez sent Deniz the revised kitchen renovation contract on 2026-10-12.
- Acme Build (org): Acme Build can start the kitchen renovation on 2 November once the revised contract is signed.
- Kitchen renovation (project): The revised contract totals $18,400.
- Kitchen renovation (project): Acme Build can start on 2 November once the contract is signed.

**`z-ai/glm-5.3`**: ✅ Mark not called a colleague; ✅ keeps the renovation contract

- [people] Mark Tellez: project manager at Acme Build; sent the revised kitchen renovation contract totalling $18,400.
- [commitments] Sign the revised kitchen renovation contract from Acme Build, total $18,400, so work can start on 2 November.
- [interests] Renovating the kitchen, using Acme Build as the contractor.
- [recent] Received the revised kitchen renovation contract from Mark Tellez at Acme Build, total $18,400, with work to start on 2 November once signed.
- Mark Tellez (person): Project Manager at Acme Build.
- Mark Tellez (person): Sent the revised kitchen renovation contract on 12 Oct 2026.
- Mark Tellez (person) links: Kitchen renovation, Acme Build
- Kitchen renovation (project): The revised contract totals $18,400.
- Kitchen renovation (project): Work can start on 2 November once the contract is signed.
- Kitchen renovation (project) links: Mark Tellez, Acme Build
- Acme Build (org): Contractor for the kitchen renovation.
- Acme Build (org): Mark Tellez works there as Project Manager.
- Acme Build (org) links: Mark Tellez, Kitchen renovation

**`qwen/qwen3.8-27b`**: ❌ Mark not called a colleague (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”); ❌ keeps the renovation contract (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

## hey-bro

A friend writes "hey bro". That is a greeting, not a brother.

**`local qwen3:1.7b`**: ✅ Can not called a brother

- [people] Can Yilmaz: friend; asking if Deniz is still up for watching a match on Sunday
- [recent] Booked match on 14 Nov
- match (project): Match scheduled for 14 Nov
- match (project) links: Family dinner

**`anthropic/claude-haiku-5.5`**: ✅ Can not called a brother

- [people] Can Yilmaz: friend; invited Deniz to watch a match at his place on Sunday and asked him to bring snacks.
- [commitments] Confirm to Can Yilmaz whether Deniz is still coming to watch the match at his place on Sunday, bringing snacks.
- [interests] Enjoys watching football matches with friends.
- [recent] Can Yilmaz asked Deniz on 14 Oct 2026 if he is still up for watching the match on Sunday.
- Can Yilmaz (person): Invited Deniz Arslan to watch a match at his place on Sunday and asked him to bring snacks.
- Can Yilmaz (person): Emailed on 14 Oct 2026 to check Deniz is still coming.

**`openai/gpt-6-luna`**: ✅ Can not called a brother

- [people] Can Yilmaz: invited Deniz to watch a match at his place on 18 Oct 2026 and asked him to bring snacks.
- [recent] Received Can Yilmaz's invitation to watch a match at his place on 18 Oct 2026.
- Can Yilmaz (person): Invited Deniz to watch a match at his place on 18 Oct 2026 and asked him to bring snacks.

**`deepseek/deepseek-v4.1-flash-1017`**: ✅ Can not called a brother

- [people] Can Yilmaz: friend; invited Deniz to watch the match at his place on Sunday 18 Oct and asked him to bring snacks.
- [commitments] Bring snacks to Can Yilmaz's place for the match on Sunday 18 Oct, if still going.
- [interests] Watches matches with friends, often at Can Yilmaz's place.
- [recent] Can Yilmaz asked whether he is still up for watching the match at his place on Sunday 18 Oct.
- Can Yilmaz (person): Invited Deniz to watch the match at his place on Sunday 18 Oct.
- Can Yilmaz (person): Asked Deniz to bring snacks.

**`moonshotai/kimi-k3.1-pro`**: ❌ Can not called a brother (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

**`z-ai/glm-5.3`**: ❌ Can not called a brother (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

**`qwen/qwen3.8-27b`**: ❌ Can not called a brother (“malformed_output: malformed_output: structured output failed validation twice: not valid JSON”)

- error: malformed_output: malformed_output: structured output failed validation twice: not valid JSON

## restaurant-once

One restaurant booking. One visit is not a favourite.

**`local qwen3:1.7b`**: ✅ no liking for the restaurant

- [recent] Booked table for 2 at Olive and Vine on 23 Oct
- Olive and Vine (project): Booked table for 2 on 23 Oct

**`anthropic/claude-haiku-5.5`**: ✅ no liking for the restaurant

- [interests] Dines out at Olive and Vine, a restaurant that takes bookings by email.
- [recent] Booked a table for 2 at Olive and Vine on Friday 23 October at 19:30.
- Olive and Vine (org): Restaurant where Deniz Arslan booked a table for 2 on Friday 23 October at 19:30.

**`openai/gpt-6-luna`**: ✅ no liking for the restaurant

- [commitments] Attend a table for 2 at Olive and Vine on 23 October 2026 at 19:30.
- [recent] Booked a table for 2 at Olive and Vine for 23 October 2026 at 19:30.
- Olive and Vine (org): Booked a table for 2 for 23 October 2026 at 19:30.

**`deepseek/deepseek-v4.1-flash-1017`**: ✅ no liking for the restaurant

- [recent] Booked a table for 2 at Olive and Vine for Friday 23 October at 19:30.

**`moonshotai/kimi-k3.1-pro`**: ✅ no liking for the restaurant

- [recent] Booked a table for 2 at Olive and Vine for Friday 23 October at 19:30.
- Olive and Vine (org): Confirmed Deniz Arslan's table for 2 for Friday 23 October at 19:30.

**`z-ai/glm-5.3`**: ✅ no liking for the restaurant

- [commitments] Has a table for 2 reserved at Olive and Vine on Friday 23 October at 19:30.
- [interests] Dines out at the restaurant Olive and Vine.
- [recent] Booked a table for 2 at Olive and Vine for Friday 23 October at 19:30.
- Olive and Vine (org): Confirmed Deniz Arslan's table for 2 on Friday 23 October at 19:30.

**`qwen/qwen3.8-27b`**: ✅ no liking for the restaurant

- [recent] Booked a table for 2 at Olive and Vine for 23 October 2026 at 19:30.
- Olive and Vine (org): Deniz Arslan has a table for 2 booked there on 23 October 2026 at 19:30.
