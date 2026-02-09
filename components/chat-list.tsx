import { type Message } from 'ai'

import { Separator } from '@/components/ui/separator'
import { ChatMessage } from '@/components/chat-message'

export interface ChatList {
  messages: Message[]
}

export function ChatList({ messages }: ChatList) {
  if (!messages.length) {
    return null
  }

  return (
    <div className="relative mx-auto max-w-2xl px-4">
      {messages.map((message: any, index) => {
        // ✅ FIX: Better message parsing logic
        let displayMessage = message;
        
        // Only try to parse if content looks like JSON
        if (typeof message.content === 'string' && 
            message.content.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(message.content);
            if (parsed.message) {
              displayMessage = parsed.message;
            }
          } catch (error) {
            // Not JSON, use original message
            console.log('Message is not JSON, using as-is');
          }
        }

        return (
          <div key={message.id || index}>
            <ChatMessage message={displayMessage} />
            {index < messages.length - 1 && (
              <Separator className="my-4 md:my-8" />
            )}
          </div>
        )
      })}
    </div>
  )
}