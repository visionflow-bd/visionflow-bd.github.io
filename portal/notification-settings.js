export function notificationSettings(input={}) {
  const label=(value,fallback)=>String(value||fallback).trim().replace(/[\r\n]/g,' ').slice(0,120);
  const email=value=>String(value||'').trim();
  return {schemaVersion:2,enabled:input.enabled===true,clientEnabled:input.clientEnabled!==false,adminEnabled:input.adminEnabled!==false,
    clientSenderName:label(input.clientSenderName,'Vision Flow'),adminSenderName:label(input.adminSenderName,'Vision Flow Team'),
    clientReplyTo:email(input.clientReplyTo),adminReplyTo:email(input.adminReplyTo),adminEmail:email(input.adminEmail)};
}
export function validateNotificationSettings(settings) {
  const valid=value=>typeof value==='string'&&value.length<=254&&/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value);
  for(const key of ['adminEmail','clientReplyTo','adminReplyTo'])if(settings[key]&&!valid(settings[key]))throw Error('Enter one valid email address per field.');
  if(settings.enabled&&settings.adminEnabled&&!valid(settings.adminEmail))throw Error('Add the internal-team recipient before enabling team alerts.');
  if(settings.enabled&&!settings.clientEnabled&&!settings.adminEnabled)throw Error('Enable at least one notification audience.');
  return settings;
}
