export interface PublishInput { file: string; title: string; description?: string; existingUrl?: string | null }
export interface PublishResult { url: string }
export interface PagePublisher { kind: string; label: string; publish(input: PublishInput): Promise<PublishResult> }
