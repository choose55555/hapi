import type { Database } from 'bun:sqlite'

import type { StoredPushSubscription } from './types'
import { addPushSubscription, getPushSubscriptionsByNamespace, removePushSubscription } from './pushSubscriptions'

export class PushStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getCredentialReminderNamespaces(): string[] {
        return (this.db.query(
            'SELECT DISTINCT namespace FROM push_subscriptions UNION SELECT DISTINCT namespace FROM fcm_devices'
        ).all() as Array<{ namespace: string }>).map(row => row.namespace)
    }

    addPushSubscription(namespace: string, subscription: { endpoint: string; p256dh: string; auth: string }): void {
        addPushSubscription(this.db, namespace, subscription)
    }

    removePushSubscription(namespace: string, endpoint: string): void {
        removePushSubscription(this.db, namespace, endpoint)
    }

    getPushSubscriptionsByNamespace(namespace: string): StoredPushSubscription[] {
        return getPushSubscriptionsByNamespace(this.db, namespace)
    }
}
