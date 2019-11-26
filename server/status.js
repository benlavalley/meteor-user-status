/*
  Apparently, the new api.export takes care of issues here. No need to attach to global namespace.
  See http://shiggyenterprises.wordpress.com/2013/09/09/meteor-packages-in-coffeescript-0-6-5/

  We may want to make UserSessions a server collection to take advantage of indices.
  Will implement if someone has enough online users to warrant it.
*/
import { Accounts } from 'meteor/accounts-base';
import { check, Match } from 'meteor/check';
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { _ } from 'meteor/underscore';
import { EventEmitter } from 'events';

export const userStatusConfig = {};

const UserConnections = new Mongo.Collection('user_status_sessions', {
	connection: null,
});

const statusEvents = new (EventEmitter)();

userStatusConfig.updateCollection = Meteor.users;
userStatusConfig._id = '_id';
userStatusConfig.statusOnline = 'status.online';
userStatusConfig.statusIdle = 'status.idle';
userStatusConfig.statusLastActivity = 'status.lastActivity';
userStatusConfig.statusLastLoginDate = 'status.lastLogin.date';
userStatusConfig.statusUserIpAddr = 'status.lastLogin.ipAddr';
userStatusConfig.statusUserAgent = 'status.lastLogin.userAgent';
userStatusConfig.customOptions = {};

Meteor.startup(function () {
	if (userStatusConfig.customCollection) {
		userStatusConfig.updateCollection = userStatusConfig.customCollection.collectionName;
		if (!userStatusConfig.updateCollection) {
			throw new Error(`meteor-user-status has custom collection usage defined but custom collection missing! full config: ${JSON.stringify(userStatusConfig)}`);
		}
		try {
			userStatusConfig.updateCollection.findOne({}, { fields: { _id: 1 } });
		} catch (e) {
			console.log(e);
			throw new Error('meteor-user-status has custom collection defined but mongo error trying to access collection.');
		}
		if (userStatusConfig.customCollection.customMapping) {
			userStatusConfig._id = userStatusConfig.customCollection.customMapping._id || userStatusConfig._id;
			userStatusConfig.statusOnline = userStatusConfig.customCollection.customMapping['status.online'] || userStatusConfig.statusOnline;
			userStatusConfig.statusIdle = userStatusConfig.customCollection.customMapping['status.idle'] || userStatusConfig.statusIdle;
			userStatusConfig.statusLastActivity = userStatusConfig.customCollection.customMapping['status.lastActivity'] || userStatusConfig.statusLastActivity;
			userStatusConfig.statusLastLoginDate = userStatusConfig.customCollection.customMapping['status.lastLogin.date'] || userStatusConfig.statusLastLoginDate;
			userStatusConfig.statusUserIpAddr = userStatusConfig.customCollection.customMapping['status.lastLogin.ipAddr'] || userStatusConfig.statusUserIpAddr;
			userStatusConfig.statusUserAgent = userStatusConfig.customCollection.customMapping['status.lastLogin.userAgent'] || userStatusConfig.statusUserAgent;
		}
		if (userStatusConfig.customCollection.customOptions) {
			userStatusConfig.customOptions = userStatusConfig.customCollection.customOptions || userStatusConfig.customOptions;
		}
	}
});

/*
  Multiplex login/logout events to status.online

  'online' field is "true" if user is online, and "false" otherwise

  'idle' field is tri-stated:
  - "true" if user is online and not idle
  - "false" if user is online and idle
  - null if user is offline
*/
statusEvents.on('connectionLogin', (advice) => {
	const update = {
		$set: {
			[userStatusConfig.statusOnline]: true,
			[userStatusConfig.statusLastLoginDate]: advice.loginTime,
			[userStatusConfig.statusUserIpAddr]: advice.ipAddr,
			[userStatusConfig.statusUserAgent]: advice.userAgent,
		},
	};

	// unless ALL existing connections are idle (including this new one),
	// the user connection becomes active.
	const conns = UserConnections.find({
		userId: advice.userId,
	}).fetch();
	if (!_.every(conns, (c) => c.idle)) {
		update.$set[userStatusConfig.statusIdle] = false;
		update.$unset = {
			[userStatusConfig.statusLastActivity]: 1,
		};
	}
	// in other case, idle field remains true and no update to lastActivity.

	advice.userId && userStatusConfig.updateCollection.update({ [userStatusConfig._id]: advice.userId }, update, userStatusConfig.customOptions);
});

statusEvents.on('connectionLogout', (advice) => {
	const conns = UserConnections.find({
		userId: advice.userId,
	}).fetch();
	if (conns.length === 0) {
		// Go offline if we are the last connection for this user
		// This includes removing all idle information
		advice.userId && userStatusConfig.updateCollection.update({ [userStatusConfig._id]: advice.userId }, {
			$set: {
				[userStatusConfig.statusOnline]: false,
			},
			$unset: {
				[userStatusConfig.statusIdle]: 1,
				[userStatusConfig.statusLastActivity]: 1,
			},
		}, userStatusConfig.customOptions);
	} else if (_.every(conns, (c) => c.idle)) {
		/*
      All remaining connections are idle:
      - If the last active connection quit, then we should go idle with the most recent activity

      - If an idle connection quit, nothing should happen; specifically, if the
        most recently active idle connection quit, we shouldn't tick the value backwards.
        This may result in a no-op so we can be smart and skip the update.
    */
		if (advice.lastActivity != null) {
			return;
		} // The dropped connection was already idle

		advice.userId && userStatusConfig.updateCollection.update({ [userStatusConfig._id]: advice.userId }, {
			$set: {
				[userStatusConfig.statusIdle]: true,
				[userStatusConfig.statusLastActivity]: _.max(_.pluck(conns, 'lastActivity')),
			},
		}, userStatusConfig.customOptions);
	}
});

/*
  Multiplex idle/active events to status.idle
  TODO: Hopefully this is quick because it's all in memory, but we can use indices if it turns out to be slow

  TODO: There is a race condition when switching between tabs, leaving the user inactive while idle goes from one tab to the other.
  It can probably be smoothed out.
*/
statusEvents.on('connectionIdle', (advice) => {
	const conns = UserConnections.find({
		userId: advice.userId,
	}).fetch();
	if (!_.every(conns, (c) => c.idle)) {
		return;
	}
	// Set user to idle if all the connections are idle
	// This will not be the most recent idle across a disconnection, so we use max

	// TODO: the race happens here where everyone was idle when we looked for them but now one of them isn't.
	advice.userId && userStatusConfig.updateCollection.update({ [userStatusConfig._id]: advice.userId }, {
		$set: {
			[userStatusConfig.statusIdle]: true,
			[userStatusConfig.statusLastActivity]: _.max(_.pluck(conns, 'lastActivity')),
		},
	}, userStatusConfig.customOptions);
});

statusEvents.on('connectionActive', (advice) => {
	advice.userId && userStatusConfig.updateCollection.update({ [userStatusConfig._id]: advice.userId }, {
		$set: {
			[userStatusConfig.statusIdle]: false,
		},
		$unset: {
			[userStatusConfig.statusLastActivity]: 1,
		},
	}, userStatusConfig.customOptions);
});

// Reset online status on startup (users will reconnect)
const onStartup = (selector) => {
	console.log('onStartup executing! userStatusConfig.noResetStartup ', userStatusConfig.noResetStartup);
	if (selector == null) {
		selector = {};
	}
	Object.assign(userStatusConfig.customOptions, { multi: true });
	return !userStatusConfig.noResetStartup && userStatusConfig.updateCollection.update(selector, {
		$set: {
			[userStatusConfig.statusOnline]: false,
		},
		$unset: {
			[userStatusConfig.statusIdle]: 1,
			[userStatusConfig.statusLastActivity]: 1,
		},
	}, userStatusConfig.customOptions);
};

/*
  Local session modification functions - also used in testing
*/

const addSession = (connection) => {
	UserConnections.upsert(connection.id, {
		$set: {
			ipAddr: connection.clientAddress,
			userAgent: connection.httpHeaders['user-agent'],
		},
	});
};

const loginSession = (connection, date, userId) => {
	UserConnections.upsert(connection.id, {
		$set: {
			userId,
			loginTime: date,
		},
	});

	statusEvents.emit('connectionLogin', {
		userId,
		connectionId: connection.id,
		ipAddr: connection.clientAddress,
		userAgent: connection.httpHeaders['user-agent'],
		loginTime: date,
	});
};

// Possibly trigger a logout event if this connection was previously associated with a user ID
const tryLogoutSession = (connection, date) => {
	let conn;
	if ((conn = UserConnections.findOne({
		_id: connection.id,
		userId: {
			$exists: true,
		},
	})) == null) {
		return false;
	}

	// Yes, this is actually a user logging out.
	UserConnections.upsert(connection.id, {
		$unset: {
			userId: 1,
			loginTime: 1,
		},
	});

	return statusEvents.emit('connectionLogout', {
		userId: conn.userId,
		connectionId: connection.id,
		lastActivity: conn.lastActivity, // If this connection was idle, pass the last activity we saw
		logoutTime: date,
	});
};

const removeSession = (connection, date) => {
	tryLogoutSession(connection, date);
	UserConnections.remove(connection.id);
};

const idleSession = (connection, date, userId) => {
	UserConnections.update(connection.id, {
		$set: {
			idle: true,
			lastActivity: date,
		},
	});

	statusEvents.emit('connectionIdle', {
		userId,
		connectionId: connection.id,
		lastActivity: date,
	});
};

const activeSession = (connection, date, userId) => {
	UserConnections.update(connection.id, {
		$set: {
			idle: false,
		},
		$unset: {
			lastActivity: 1,
		},
	});

	statusEvents.emit('connectionActive', {
		userId,
		connectionId: connection.id,
		lastActivity: date,
	});
};

/*
  Handlers for various client-side events
*/
Meteor.startup(onStartup);

// Opening and closing of DDP connections
Meteor.onConnection((connection) => {
	addSession(connection);

	return connection.onClose(() => removeSession(connection, new Date()));
});

// Authentication of a DDP connection
Accounts.onLogin((info) => loginSession(info.connection, new Date(), info.user._id));

// pub/sub trick as referenced in http://stackoverflow.com/q/10257958/586086
// We used this in the past, but still need this to detect logouts on the same connection.
Meteor.publish(null, function () {
	// Return null explicitly if this._session is not available, i.e.:
	// https://github.com/arunoda/meteor-fast-render/issues/41
	if (this._session == null) {
		return [];
	}

	// We're interested in logout events - re-publishes for which a past connection exists
	if (this.userId == null) {
		tryLogoutSession(this._session.connectionHandle, new Date());
	}

	return [];
});

// We can use the client's timestamp here because it was sent from a TimeSync
// value, however we should never trust it for something security dependent.
// If timestamp is not provided (probably due to a desync), use server time.
Meteor.methods({
	'user-status-idle': function (timestamp) {
		check(timestamp, Match.OneOf(null, undefined, Date, Number));

		const date = (timestamp != null) ? new Date(timestamp) : new Date();
		idleSession(this.connection, date, this.userId);
	},

	'user-status-active': function (timestamp) {
		check(timestamp, Match.OneOf(null, undefined, Date, Number));

		// We only use timestamp because it's when we saw activity *on the client*
		// as opposed to just being notified it. It is probably more accurate even if
		// a dozen ms off due to the latency of sending it to the server.
		const date = (timestamp != null) ? new Date(timestamp) : new Date();
		activeSession(this.connection, date, this.userId);
	},
});

// Exported variable
export const UserStatus = {
	connections: UserConnections,
	events: statusEvents,
};

// Internal functions, exported for testing
export const StatusInternals = {
	onStartup,
	addSession,
	removeSession,
	loginSession,
	tryLogoutSession,
	idleSession,
	activeSession,
};
