import { Alert, Typography } from '@mui/material';
import { SettingsPage, Num, Bool, Lines, Text } from './common.jsx';
import { useAuth } from '../../AuthContext.jsx';

export default function Security() {
  const { can } = useAuth();
  return (
    <SettingsPage title="Security" url="/api/admin/security" readOnly={!can('security.write')} intro="Multi-factor authentication enforcement, session lifetimes, and local-login policy. Saving requires re-verification.">
      {(f, set) => (<>
        <Typography variant="subtitle2">MFA enforcement</Typography>
        <Alert severity="info">Local (break-glass) accounts always require MFA. For SSO users, MFA is performed by your IdP and verified here from the assertion.</Alert>
        <Bool label="Require MFA for everyone" value={f.requireMfaEveryone} onChange={set('requireMfaEveryone')} />
        <Lines label="…or require MFA for these roles (one per line)" value={f.requireMfaRoles} onChange={set('requireMfaRoles')} />
        <Lines label="Accepted AuthnContextClassRef values (one per line)" value={f.samlRequiredAuthnContexts} onChange={set('samlRequiredAuthnContexts')} />
        <Lines label="Accepted 'amr' attribute values (one per line)" value={f.samlRequiredAmr} onChange={set('samlRequiredAmr')} />
        <Bool label="My IdP enforces MFA but doesn't assert it (skip the AuthnContext/amr check; requires SAML to be enabled)" value={f.samlTrustIdpMfa} onChange={set('samlTrustIdpMfa')} />
        <Text label="'amr' attribute name" value={f.samlAmrAttribute} onChange={set('samlAmrAttribute')} />
        <Num label="Maximum authentication age (seconds, 0 = unlimited)" value={f.samlMaxAuthAgeSec} onChange={set('samlMaxAuthAgeSec')} />
        <Bool label="Force re-authentication at the IdP on every sign-in" value={f.samlForceAuthn} onChange={set('samlForceAuthn')} />
        <Num label="Enrollment grace period for local accounts (days)" value={f.mfaGraceDays} onChange={set('mfaGraceDays')} />
        <Num label="Step-up window for sensitive actions (seconds)" value={f.stepupWindowSec} onChange={set('stepupWindowSec')} />
        <Typography variant="subtitle2">Sessions</Typography>
        <Num label="Idle timeout (seconds)" value={f.sessionIdleSec} onChange={set('sessionIdleSec')} />
        <Num label="Absolute lifetime (seconds)" value={f.sessionAbsoluteSec} onChange={set('sessionAbsoluteSec')} />
        <Typography variant="subtitle2">Local authentication</Typography>
        <Bool label="Allow local sign-in" value={f.localLoginEnabled} onChange={set('localLoginEnabled')} />
        <Bool label="Restrict local sign-in to break-glass accounts" value={f.breakGlassOnly} onChange={set('breakGlassOnly')} />
        <Num label="Minimum password length" value={f.passwordMinLength} onChange={set('passwordMinLength')} />
        <Num label="Lock out after N failed attempts" value={f.lockoutThreshold} onChange={set('lockoutThreshold')} />
        <Num label="Base lockout (minutes, doubles on repeats)" value={f.lockoutMinutes} onChange={set('lockoutMinutes')} />
      </>)}
    </SettingsPage>
  );
}
