package rtpconn

import (
	"slices"

	"github.com/jech/galene/group"
)

func (c *webClient) sendBreakoutState() error {
	g := c.group
	if g == nil || slices.Contains(c.permissions, "system") || slices.Contains(c.permissions, "caption-on-demand") {
		return nil
	}
	return c.write(clientMessage{
		Type: "usermessage", Kind: "breakout-state", Group: g.Name(),
		Privileged: true, Value: g.BreakoutView(c, g),
	})
}

func notifyBreakouts(root *group.Group) {
	for _, member := range root.BreakoutClients() {
		if target, ok := member.(*webClient); ok {
			target.action(breakoutUpdateAction{root})
		}
	}
}

func (c *webClient) moveBreakout(key string) error {
	root := c.group.BreakoutRoot()
	target, err := root.MoveBreakout(c, c.group, key, func() { c.data = nil })
	if err != nil || target == nil {
		return err
	}
	closeGroupMedia(c)
	c.group = target
	c.requested = make(map[string][]string)
	notifyBreakouts(root)
	return nil
}

func (c *webClient) handleBreakout(action string, value any) error {
	g := c.group
	root := g.BreakoutRoot()
	err := c.applyBreakout(action, value, root)
	if err != nil {
		return c.write(clientMessage{
			Type: "usermessage", Kind: "breakout-error", Group: g.Name(),
			Privileged: true, Value: err.Error(),
		})
	}
	return nil
}

func (c *webClient) applyBreakout(action string, value any, root *group.Group) error {
	switch action {
	case "join":
		key, ok := value.(string)
		if !ok || len(key) != 1 || key[0] < '1' || key[0] > '8' {
			return group.UserError("unknown breakout room")
		}
		return c.moveBreakout(key)
	case "return":
		if c.group != root {
			return c.moveBreakout("")
		}
	case "launch", "assign", "close":
		if c.group != root || !slices.Contains(c.permissions, "op") {
			return group.UserError("not authorised")
		}
		if action == "close" {
			returning, err := root.CloseBreakouts(c)
			if err != nil {
				return err
			}
			for _, member := range returning {
				if target, ok := member.Client.(*webClient); ok {
					target.action(breakoutRecallAction{member.Room})
				}
			}
		} else {
			data, ok := value.(map[string]any)
			if !ok {
				return group.UserError("invalid breakout configuration")
			}
			if action == "assign" {
				id, _ := data["id"].(string)
				key, ok := data["room"].(string)
				if !ok {
					return group.UserError("invalid breakout room")
				}
				if err := root.AssignBreakout(c, id, key); err != nil {
					return err
				}
			} else {
				names, _ := data["rooms"].([]any)
				if len(names) < 2 || len(names) > 8 {
					return group.UserError("choose between two and eight rooms")
				}
				titles := make([]string, len(names))
				for i, name := range names {
					titles[i], _ = name.(string)
				}
				mapping, _ := data["assignments"].(map[string]any)
				assignments := make(map[string]string, len(mapping))
				for id, entry := range mapping {
					if key, ok := entry.(string); ok {
						assignments[id] = key
					}
				}
				if err := root.LaunchBreakouts(c, titles, assignments); err != nil {
					return err
				}
			}
		}
		notifyBreakouts(root)
	default:
		return group.UserError("unknown breakout action")
	}
	return nil
}
