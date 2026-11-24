package group

import (
	"slices"
	"strings"
	"unicode/utf8"
)

type meetingPoll struct {
	id       uint64
	question string
	options  []string
	votes    map[string]int
	closed   bool
}

type meetingQuestion struct {
	id       uint64
	text     string
	author   string
	authorID string
	votes    map[string]bool
	done     bool
}

type meetingState struct {
	sequence  uint64
	poll      *meetingPoll
	questions []meetingQuestion
	notes     string
	version   uint64
}

type MeetingPoll struct {
	ID       uint64   `json:"id"`
	Question string   `json:"question"`
	Options  []string `json:"options"`
	Counts   []int    `json:"counts,omitempty"`
	Vote     *int     `json:"vote,omitempty"`
	Closed   bool     `json:"closed"`
}

type MeetingQuestion struct {
	ID     uint64 `json:"id"`
	Text   string `json:"text"`
	Author string `json:"author"`
	Votes  int    `json:"votes"`
	Voted  bool   `json:"voted"`
	Done   bool   `json:"done"`
	Own    bool   `json:"own"`
}

type MeetingSnapshot struct {
	Poll         *MeetingPoll      `json:"poll"`
	Questions    []MeetingQuestion `json:"questions"`
	Notes        string            `json:"notes"`
	NotesVersion uint64            `json:"notesVersion"`
}

func (g *Group) Meeting(client Client) MeetingSnapshot {
	g.mu.Lock()
	defer g.mu.Unlock()

	state := &g.meeting
	snapshot := MeetingSnapshot{Notes: state.notes, NotesVersion: state.version}
	if p := state.poll; p != nil {
		poll := MeetingPoll{ID: p.id, Question: p.question, Options: slices.Clone(p.options), Closed: p.closed}
		if vote, found := p.votes[client.Id()]; found {
			poll.Vote = &vote
		}
		if poll.Closed || slices.Contains(client.Permissions(), "op") {
			poll.Counts = make([]int, len(poll.Options))
			for _, vote := range p.votes {
				poll.Counts[vote]++
			}
		}
		snapshot.Poll = &poll
	}
	for _, q := range state.questions {
		snapshot.Questions = append(snapshot.Questions, MeetingQuestion{
			ID: q.id, Text: q.text, Author: q.author, Votes: len(q.votes),
			Voted: q.votes[client.Id()], Done: q.done, Own: q.authorID == client.Id(),
		})
	}
	return snapshot
}

func meetingText(value any, limit int) string {
	text, _ := value.(string)
	text = strings.TrimSpace(text)
	if utf8.RuneCountInString(text) > limit {
		return ""
	}
	return text
}

func meetingInt(value any, max uint64) (uint64, bool) {
	number, ok := value.(float64)
	if !ok || number < 0 || number > float64(max) || float64(uint64(number)) != number {
		return 0, false
	}
	return uint64(number), true
}

func (g *Group) ChangeMeeting(client Client, action string, data map[string]any) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.clients[client.Id()] != client {
		return UserError("not authorised")
	}
	op := slices.Contains(client.Permissions(), "op")
	canParticipate := op || slices.Contains(client.Permissions(), "message")
	state := &g.meeting

	switch action {
	case "poll-open":
		if !op {
			return UserError("not authorised")
		}
		if state.poll != nil && !state.poll.closed {
			return UserError("close the active poll first")
		}
		question := meetingText(data["question"], 240)
		options, ok := data["options"].([]any)
		if question == "" || !ok || len(options) < 2 || len(options) > 6 {
			return UserError("invalid poll")
		}
		values := make([]string, 0, len(options))
		for _, option := range options {
			text := meetingText(option, 100)
			if text == "" || slices.Contains(values, text) {
				return UserError("invalid poll option")
			}
			values = append(values, text)
		}
		state.sequence++
		state.poll = &meetingPoll{id: state.sequence, question: question, options: values, votes: make(map[string]int)}
	case "poll-vote", "poll-close":
		p := state.poll
		id, ok := meetingInt(data["id"], state.sequence)
		if !ok || p == nil || p.closed || id != p.id {
			return UserError("poll is closed or has changed")
		}
		if action == "poll-close" {
			if !op {
				return UserError("not authorised")
			}
			p.closed = true
		} else {
			if !canParticipate {
				return UserError("not authorised")
			}
			vote, ok := meetingInt(data["option"], uint64(len(p.options)-1))
			if !ok {
				return UserError("invalid poll option")
			}
			p.votes[client.Id()] = int(vote)
		}
	case "question-add":
		if !canParticipate {
			return UserError("not authorised")
		}
		text := meetingText(data["text"], 400)
		if text == "" || len(state.questions) >= 50 {
			return UserError("invalid question or question limit reached")
		}
		state.sequence++
		state.questions = append(state.questions, meetingQuestion{
			id: state.sequence, text: text, author: client.Username(), authorID: client.Id(), votes: make(map[string]bool),
		})
	case "question-vote", "question-done":
		id, ok := meetingInt(data["id"], state.sequence)
		index := slices.IndexFunc(state.questions, func(q meetingQuestion) bool { return q.id == id })
		if !ok || index < 0 {
			return UserError("unknown question")
		}
		q := &state.questions[index]
		if action == "question-done" {
			if !op {
				return UserError("not authorised")
			}
			q.done = true
		} else {
			if !canParticipate || q.done {
				return UserError("question is closed")
			}
			if q.votes[client.Id()] {
				delete(q.votes, client.Id())
			} else {
				q.votes[client.Id()] = true
			}
		}
	case "notes-save":
		version, ok := meetingInt(data["version"], state.version)
		if !op {
			return UserError("not authorised")
		}
		if !ok || version != state.version {
			return UserError("notes have changed")
		}
		notes, ok := data["text"].(string)
		if !ok || utf8.RuneCountInString(notes) > 8000 {
			return UserError("invalid notes")
		}
		state.notes = strings.TrimSpace(notes)
		state.version++
	default:
		return UserError("unknown meeting action")
	}
	return nil
}
