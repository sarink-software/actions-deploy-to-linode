// Import modules with "* as" https://github.com/vercel/ncc/issues/621
import * as artifact from '@actions/artifact';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  createDomain,
  CreateDomainPayload,
  createDomainRecord,
  createLinode,
  CreateLinodeRequest,
  Domain,
  DomainRecord,
  getDomainRecords,
  getDomains,
  getLinodes,
  Linode,
  setToken,
  updateDomainRecord,
} from '@linode/api-v4';
import fs from 'fs';
import { find, uniq } from 'lodash';
import { NodeSSH, SSHExecCommandOptions } from 'node-ssh';
import ora from 'ora';
import { parseDomain, ParseResultType } from 'parse-domain';
import shortuuid from 'short-uuid';
import waitOn from 'wait-on';

const startLoader = (options: ora.Options) => {
  const loader = ora(options);
  loader.start();
  return loader;
};

const logRecord = (record: DomainRecord, domainId: Domain['id']) =>
  `${record.type} Record: '${record.name}' (${record.id}) with target: ${record.target} for Domain: ${domainId}`;

const logDomain = (domain: Domain) => `Domain: ${domain.domain} (${domain.id})`;

const logLinode = (linode: Linode) => `Linode: ${linode.label}@${linode.ipv4[0]} (${linode.id})`;

const findDomainByName = async (name: Domain['domain']) =>
  (await getDomains()).data.find((d) => d.domain === name);

const findRecordForDomain = async (domainId: Domain['id'], findOptions: Partial<DomainRecord>) =>
  find((await getDomainRecords(domainId)).data, findOptions);

const findLinodeByIp = async (ipv4: string) =>
  (await getLinodes()).data.find((linode) => linode.ipv4.includes(ipv4));

const findLinodeByLabel = async (label: string) =>
  (await getLinodes()).data.find((linode) => linode.label === label);

const findOrCreateDomain = async (name: Domain['domain'], createOptions: CreateDomainPayload) => {
  const existingDomain = await findDomainByName(name);
  if (existingDomain) {
    core.info(`Using existing ${logDomain(existingDomain)}`);
    return existingDomain;
  }
  const loader = startLoader({ text: 'Creating new Domain...' });
  core.debug(JSON.stringify(createOptions));
  const newDomain = await createDomain({ type: 'master', ...createOptions, domain: name });
  loader.stop();
  core.info(`Created new ${logDomain(newDomain)}`);
  return newDomain;
};

const updateOrCreateARecord = async (
  domainId: Domain['id'],
  attrs: Partial<DomainRecord> & { name: string; target: string }
) => {
  const existingRecord = await findRecordForDomain(domainId, { type: 'A', name: attrs.name });
  const keysToUpdate = Object.keys(attrs) as (keyof DomainRecord)[];
  const existingRecordNeedsUpdating =
    existingRecord && keysToUpdate.some((key) => existingRecord[key] !== attrs[key]);

  if (existingRecord && !existingRecordNeedsUpdating) {
    core.info(`Using existing ${logRecord(existingRecord, domainId)}`);
    return existingRecord;
  }

  if (existingRecord && existingRecordNeedsUpdating) {
    const updatedRecord = await updateDomainRecord(domainId, existingRecord.id, attrs);
    core.info(`Updated ${logRecord(updatedRecord, domainId)}`);
    return updatedRecord;
  }

  const newAttrs = { type: 'A' as const, ...attrs };
  const loader = startLoader({ text: `Creating new A Record ${newAttrs.name}...` });
  core.debug(JSON.stringify(newAttrs));
  const newRecord = await createDomainRecord(domainId, newAttrs);
  loader.stop();
  core.info(`Created new ${logRecord(newRecord, domainId)}`);
  return newRecord;
};

const findOrCreateLinode = async (
  label: string,
  createOptions: Omit<CreateLinodeRequest, 'stackscript_data'> & {
    root_pass: string;
    stackscript_data: {
      admin_users_json: string;
      deploy_user: string;
      deploy_user_public_key: string;
    };
  }
) => {
  const existingLinode = await findLinodeByLabel(label);
  if (existingLinode) {
    core.info(`Using existing ${logLinode(existingLinode)}`);
    return existingLinode;
  }
  const loader = startLoader({ text: 'Creating new Linode...' });
  core.debug(
    JSON.stringify({
      type: 'g6-nanode-1',
      region: 'us-central',
      stackscript_id: 693032,
      image: 'linode/centos7',
      booted: true,
      ...createOptions,
    })
  );
  const newLinode = await createLinode({
    label,
    type: 'g6-nanode-1',
    region: 'us-central',
    stackscript_id: 693032,
    image: 'linode/centos7',
    booted: true,
    ...createOptions,
  });
  loader.stop();
  core.info(`Created new ${logLinode(newLinode)}`);
  return newLinode;
};

(async () => {
  const input = {
    appEnv: core.getInput('app-env', { required: true }),
    linodePat: core.getInput('linode-pat', { required: true }),
    linodeLabel: core.getInput('linode-label', { required: true }),
    linodeAdminUsersFile: core.getInput('linode-admin-users-file'),
    linodeRootPass: core.getInput('root-pass') || shortuuid.generate(),
    domains: core.getInput('domains', { required: true }),
    email: core.getInput('email', { required: true }),
    deployArtifact: core.getInput('deploy-artifact', { required: true }),
    deployCommand: core.getInput('deploy-command', { required: true }),
    deployUser: core.getInput('deploy-user'),
    deployUserPublicKey: core.getInput('deploy-user-public-key', { required: true }),
    deployUserPrivateKey: core.getInput('deploy-user-private-key', { required: true }),
    healthcheckUrls: core.getInput('healthcheck-urls') || '',
  };

  core.setSecret(input.linodePat);
  core.setSecret(input.linodeRootPass);
  core.setSecret(input.deployUserPrivateKey);

  setToken(input.linodePat);

  const linode = await findOrCreateLinode(input.linodeLabel, {
    root_pass: input.linodeRootPass,
    stackscript_data: {
      admin_users_json: input.linodeAdminUsersFile
        ? fs.readFileSync(input.linodeAdminUsersFile, 'utf-8')
        : '[]',
      deploy_user: input.deployUser,
      deploy_user_public_key: input.deployUserPublicKey,
    },
  });

  const parsedDomains = input.domains.split(',').reduce((accDomains, domainStr) => {
    const parsed = parseDomain(domainStr);
    if (parsed.type !== ParseResultType.Listed) throw new Error('Invalid domains string');
    const name = `${parsed.domain}.${parsed.topLevelDomains}`;
    const subdomains = uniq([...(accDomains[name] || []), parsed.subDomains.join('.')]).filter(
      Boolean
    );
    return { ...accDomains, [name]: subdomains };
  }, {} as Record<string, string[]>);

  core.debug('Parsed domains:');
  Object.entries(parsedDomains).forEach(([name, subdomains]) => {
    core.debug(`domain: ${name}, subdomains: ${subdomains.join(', ')}`);
  });

  await Promise.all(
    Object.entries(parsedDomains).map(async ([name, subdomains]) => {
      const domain = await findOrCreateDomain(name, { soa_email: input.email });
      const allARecordNames = uniq(['', ...subdomains]);
      await Promise.all(
        allARecordNames.map((name) =>
          updateOrCreateARecord(domain.id, { name, target: linode.ipv4[0] })
        )
      );
      core.info(
        `Successfully linked Domain ${domain.domain} with Linode ${linode.label} (${linode.ipv4[0]})`
      );
    })
  );

  const linodeHost = linode.ipv4[0];
  const linodeUrl = `http://${linodeHost}`;
  const loader = startLoader({
    text: `Waiting for Linode to initialize (checking ${linodeUrl})...`,
  });
  await waitOn({
    log: core.isDebug(),
    resources: [linodeUrl],
    interval: 10 * 1000,
    timeout: 10 * 60 * 1000,
    validateStatus: (status) => status >= 200 && status <= 503,
  }).catch((e) => {
    loader.stop();
    throw e;
  });
  core.info(`Success! ${linodeUrl} is up and running. Connected domains are: ${input.domains}`);

  const ssh = new NodeSSH();

  core.info(`SSHing ${input.deployUser}@${linodeHost}...`);
  await ssh.connect({
    host: linodeHost,
    username: input.deployUser,
    privateKey: input.deployUserPrivateKey,
  });

  const artifactClient = artifact.create();
  const downloadedArtifact = await artifactClient.downloadArtifact(input.deployArtifact);
  const { downloadPath, artifactName } = downloadedArtifact;
  const localArtifact = `${downloadPath}/${artifactName}`;
  const remoteArtifact = `/tmp/deploy/${downloadedArtifact.artifactName}`;
  core.info(`Copying artifact ${localArtifact} to ${linodeHost}:${remoteArtifact}...`);
  await ssh.putFile(localArtifact, remoteArtifact);

  const BASE_DEPLOY_DIRECTORY = '/srv/deploy'; // This value is also hardcoded in the stackscript
  const REPO_NAME = github.context.repo.repo;
  const deployDir = `${BASE_DEPLOY_DIRECTORY}/${REPO_NAME}/${REPO_NAME}-${input.appEnv}`;
  const newStagingDir = `/tmp/deploy/${REPO_NAME}-${input.appEnv}-new-staging`;
  const backupDir = `/tmp/deploy/${REPO_NAME}-${input.appEnv}-backup`;

  const sshExecCommand = async (cmd: string, options?: SSHExecCommandOptions) => {
    const PS1 = `${input.deployUser}@${linodeHost}:${options?.cwd || '/'}$`;
    core.info(`${PS1} ${cmd}`);
    const errors: string[] = [];
    const resp = await ssh.execCommand(cmd, {
      onStdout: (chunk) => {
        core.info(chunk.toString('utf-8'));
      },
      onStderr: (chunk) => {
        core.error(chunk.toString('utf-8'));
        errors.push(chunk.toString('utf-8'));
      },
      ...options,
    });
    if (errors.length > 0) throw new Error(errors.join('\n'));
    return resp;
  };

  const v = core.isDebug() ? 'v' : '';

  core.info('Creating backup...');
  await sshExecCommand(`mkdir -p "${deployDir}"`);
  await sshExecCommand(`rm -${v}rf "${backupDir}"`);
  await sshExecCommand(`cp -${v}arT "${deployDir}" "${backupDir}"`);

  try {
    core.info('Deploying...');
    await sshExecCommand(`mkdir -p "${newStagingDir}"`);
    await sshExecCommand(`mv -v "${remoteArtifact}" "${newStagingDir}/"`);
    await sshExecCommand(`tar -${v}xzf "${artifactName}"`, { cwd: newStagingDir });
    await sshExecCommand(`rm -${v}rf "${deployDir}"`);
    await sshExecCommand(`mv -v "${newStagingDir}" "${deployDir}"`);
    await sshExecCommand(input.deployCommand, { cwd: deployDir });

    if (input.healthcheckUrls) {
      core.info('Performing healthcheck...');
      await waitOn({
        resources: input.healthcheckUrls
          .split(',')
          .map((url) => (url.startsWith('http') ? url : `http://${url}`)),
        log: true,
        interval: 3 * 1000,
        followRedirect: true,
        timeout: 1 * 60 * 1000,
        validateStatus: (status) => status === 200,
      });
    }
  } catch (e) {
    core.info('Rolling back...');
    await sshExecCommand(`rm -${v}rf "${deployDir}"`);
    await sshExecCommand(`mv -v "${backupDir}" "${deployDir}"`);
    await sshExecCommand(input.deployCommand, { cwd: deployDir });
    throw e;
  } finally {
    core.info('Cleaning up...');
    await sshExecCommand(`rm -${v}rf "${remoteArtifact}" "${newStagingDir}" "${backupDir}"`);
    ssh.dispose();
  }
})().catch((error) => {
  core.setFailed(error.message);
  console.error(error);
});
