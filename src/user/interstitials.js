'use strict';

const winston = require('winston');
const util = require('util');

const user = require('.');
const db = require('../database');
const meta = require('../meta');
const privileges = require('../privileges');
const plugins = require('../plugins');
const utils = require('../utils');

const sleep = util.promisify(setTimeout);

const Interstitials = module.exports;

Interstitials.get = async (req, userData) => plugins.hooks.fire('filter:register.interstitial', {
	req,
	userData,
	interstitials: [],
});

Interstitials.email = async (data) => {
	if (!data.userData) {
		throw new Error('[[error:invalid-data]]');
	}
	if (!data.userData.updateEmail) {
		return data;
	}

	const [canManageUsers, hasPassword, hasPending] = await Promise.all([
		privileges.admin.can('admin:users', data.req.uid),
		user.hasPassword(data.userData.uid),
		user.email.isValidationPending(data.userData.uid),
	]);

	let email;
	if (data.userData.uid) {
		email = await user.getUserField(data.userData.uid, 'email');
	}

	data.interstitials.push({
		template: 'partials/email_update',
		data: {
			email,
			requireEmailAddress: meta.config.requireEmailAddress,
			issuePasswordChallenge:
				hasPassword &&
				(
					(canManageUsers && data.userData.uid === data.req.uid) || // admin changing own email
					(!canManageUsers && !!data.userData.uid) // non-admins changing own email
				),
			hasPending,
		},
		callback: async (userData, formData) => {
			if (formData.email) {
				formData.email = String(formData.email).trim();
			}

			// Validate and send email confirmation
			if (userData.uid) {
				const isSelf = parseInt(userData.uid, 10) === parseInt(data.req.uid, 10);
				const [isPasswordCorrect, canEdit, { email: current, 'email:confirmed': confirmed }, { allowed, error }] = await Promise.all([
					user.isPasswordCorrect(userData.uid, formData.password, data.req.ip),
					privileges.users.canEdit(data.req.uid, userData.uid),
					user.getUserFields(userData.uid, ['email', 'email:confirmed']),
					plugins.hooks.fire('filter:user.saveEmail', {
						uid: userData.uid,
						email: formData.email,
						registration: false,
						allowed: true, // change this value to disallow
						error: '[[error:invalid-email]]',
					}),
				]);

				if (!canManageUsers && !isPasswordCorrect) {
					await sleep(2000);
				}

				if (formData.email && formData.email.length) {
					if (!allowed || !utils.isEmailValid(formData.email)) {
						throw new Error(error);
					}

					// Handle errors when setting to same email (unconfirmed accts only)
					if (formData.email === current) {
						if (confirmed) {
							throw new Error('[[error:email-nochange]]');
						} else if (!await user.email.canSendValidation(userData.uid, current)) {
							throw new Error(`[[error:confirm-email-already-sent, ${meta.config.emailConfirmInterval}]]`);
						}
					}

					// Admins editing will auto-confirm, unless editing their own email
					if (canManageUsers && userData.uid !== data.req.uid) {
						if (!await user.email.available(formData.email)) {
							throw new Error('[[error:email-taken]]');
						}
						await user.email.remove(userData.uid);
						await user.setUserField(userData.uid, 'email', formData.email);
						await user.email.confirmByUid(userData.uid);
					} else if (canEdit) {
						if (hasPassword && !isPasswordCorrect) {
							throw new Error('[[error:invalid-password]]');
						}

						await user.email.sendValidationEmail(userData.uid, {
							email: formData.email,
							force: true,
						}).catch((err) => {
							winston.error(`[user.interstitials.email] Validation email failed to send\n[emailer.send] ${err.stack}`);
						});
						data.req.session.emailChanged = 1;
					} else {
						// User attempting to edit another user's email -- not allowed
						throw new Error('[[error:no-privileges]]');
					}
				} else {
					if (meta.config.requireEmailAddress) {
						throw new Error('[[error:invalid-email]]');
					}

					if (current.length && (!hasPassword || (hasPassword && isPasswordCorrect) || canManageUsers)) {
						// User or admin explicitly clearing their email
						await user.email.remove(userData.uid, isSelf ? data.req.session.id : null);
					}
				}
			} else {
				const { allowed, error } = await plugins.hooks.fire('filter:user.saveEmail', {
					uid: null,
					email: formData.email,
					registration: true,
					allowed: true, // change this value to disallow
					error: '[[error:invalid-email]]',
				});

				if (!allowed || (meta.config.requireEmailAddress && !(formData.email && formData.email.length))) {
					throw new Error(error);
				}

				// New registrants have the confirm email sent from user.create()
				userData.email = formData.email;
			}

			delete userData.updateEmail;
		},
	});

	return data;
};

Interstitials.gdpr = async function (data) {
	if (!meta.config.gdpr_enabled || (data.userData && data.userData.gdpr_consent)) {
		return data;
	}
	if (!data.userData) {
		throw new Error('[[error:invalid-data]]');
	}

	if (data.userData.uid) {
		const consented = await db.getObjectField(`user:${data.userData.uid}`, 'gdpr_consent');
		if (parseInt(consented, 10)) {
			return data;
		}
	}

	data.interstitials.push({
		template: 'partials/gdpr_consent',
		data: {
			digestFrequency: meta.config.dailyDigestFreq,
			digestEnabled: meta.config.dailyDigestFreq !== 'off',
		},
		callback: function (userData, formData, next) {
			if (formData.gdpr_agree_data === 'on' && formData.gdpr_agree_email === 'on') {
				userData.gdpr_consent = true;
			}

			next(userData.gdpr_consent ? null : new Error('[[register:gdpr_consent_denied]]'));
		},
	});
	return data;
};

Interstitials.tou = async function (data) {
	if (!data.userData) {
		throw new Error('[[error:invalid-data]]');
	}
	if (!meta.config.termsOfUse || data.userData.acceptTos) {
		// no ToS or ToS accepted, nothing to do
		return data;
	}

	if (data.userData.uid) {
		const accepted = await db.getObjectField(`user:${data.userData.uid}`, 'acceptTos');
		if (parseInt(accepted, 10)) {
			return data;
		}
	}

	const termsOfUse = await plugins.hooks.fire('filter:parse.post', {
		postData: {
			content: meta.config.termsOfUse || '',
		},
	});

	data.interstitials.push({
		template: 'partials/acceptTos',
		data: {
			termsOfUse: termsOfUse.postData.content,
		},
		callback: function (userData, formData, next) {
			if (formData['agree-terms'] === 'on') {
				userData.acceptTos = true;
			}

			next(userData.acceptTos ? null : new Error('[[register:terms_of_use_error]]'));
		},
	});
	return data;
};
