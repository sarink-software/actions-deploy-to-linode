import artifact from '@actions/artifact';
import core from '@actions/core';
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
import { NodeSSH } from 'node-ssh';
import ora from 'ora';
import { parseDomain, ParseResultType } from 'parse-domain';
import shortuuid from 'short-uuid';
import waitOn from 'wait-on';
import { linodePat } from './secrets';

const startLoader = (options: ora.Options) => {
  const loader = ora(options);
  loader.start();
  return loader;
};

const logRecord = (record: DomainRecord, domainId: Domain['id']) =>
  `${record.type} Record: '${record.name}' (${record.id}) with target: ${record.target} for Domain: ${domainId}`;

const logDomain = (domain: Domain) => `Domain: ${domain.domain} (${domain.id})`;

const logLinode = (linode: Linode) => `Linode: ${linode.label}@${linode.ipv4[0]} (${linode.id})`;

const findDomainByName = async (domain: Domain['domain']) =>
  (await getDomains()).data.find((d) => d.domain === domain);

const findRecordForDomain = async (domainId: Domain['id'], findOptions: Partial<DomainRecord>) =>
  find((await getDomainRecords(domainId)).data, findOptions);

const findLinodeByIp = async (ipv4: string) =>
  (await getLinodes()).data.find((linode) => linode.ipv4.includes(ipv4));

const findLinodeByLabel = async (label: string) =>
  (await getLinodes()).data.find((linode) => linode.label === label);

const findOrCreateDomain = async (domain: Domain['domain'], createOptions: CreateDomainPayload) => {
  const existingDomain = await findDomainByName(domain);
  if (existingDomain) {
    core.info(`Using existing ${logDomain(existingDomain)}`);
    return existingDomain;
  }
  const loader = startLoader({ text: 'Creating new Domain...' });
  const newDomain = await createDomain({ type: 'master', ...createOptions, domain });
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

  const loader = startLoader({ text: 'Creating new Record...' });
  const newAttrs = { type: 'A' as const, ...attrs };
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
      deploy_user_private_key: string;
    };
  }
) => {
  const existingLinode = await findLinodeByLabel(label);
  if (existingLinode) {
    core.info(`Using existing ${logLinode(existingLinode)}`);
    return existingLinode;
  }
  const loader = startLoader({ text: 'Creating new Linode...' });
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
  // core.info('Booting...');
  // await linodeBoot(newLinode.id);
  // core.info(`New Linode ${logLinode(newLinode)} is up and running!`);
  return newLinode;
};

(async () => {
  try {
    const input = {
      linodePat: core.getInput('linode-pat', { required: true }),
      linodeLabel: core.getInput('linode-label', { required: true }),
      linodeAdminUsersFile: core.getInput('linode-admin-users-file'),
      linodeRootPass: core.getInput('root-pass') || shortuuid.generate(),
      domains: core.getInput('domains', { required: true }),
      email: core.getInput('email', { required: true }),
      deployArtifact: core.getInput('deploy-artifact', { required: true }),
      deployCommand: core.getInput('deploy-command', { required: true }),
      deployDirectory: core.getInput('deploy-directory'),
      deployUser: core.getInput('deploy-user'),
      deployUserPrivateKey: core.getInput('deploy-user-private-key', { required: true }),
    };

    setToken(linodePat);

    const linode = await findOrCreateLinode(input.linodeLabel, {
      root_pass: input.linodeRootPass,
      stackscript_data: {
        admin_users_json: input.linodeAdminUsersFile
          ? fs.readFileSync(input.linodeAdminUsersFile, 'utf-8')
          : '[]',
        deploy_user: input.deployUser,
        deploy_user_private_key: input.deployUserPrivateKey,
      },
    });

    const parsedDomains = input.domains.split(',').map((domainStr) => {
      const parsedDomain = parseDomain(domainStr);
      if (parsedDomain.type !== ParseResultType.Listed) throw new Error('Invalid domains string');
      return {
        name: `${parsedDomain.domain}${parsedDomain.topLevelDomains}`,
        subdomains: parsedDomain.subDomains,
      };
    });

    await Promise.all(
      parsedDomains.map(async (parsedDomain) => {
        const domain = await findOrCreateDomain(parsedDomain.name, { soa_email: input.email });
        const allARecordNames = uniq(['', ...parsedDomain.subdomains]);
        await Promise.all(
          allARecordNames.map((name) =>
            updateOrCreateARecord(domain.id, { name, target: linode.ipv4[0] })
          )
        );
        core.info(`Successfully linked Domain ${domain.domain} with Linode ${linode.label}`);
      })
    );

    const firstDomainName = parsedDomains[0].name;
    const loader = startLoader({
      text: `Waiting for new Linode to initialize (checking http://${firstDomainName})...`,
    });
    await waitOn({
      resources: [firstDomainName],
      interval: 10 * 1000,
      timeout: 10 * 60 * 1000,
      validateStatus: (status) => status >= 200 && status <= 503,
    }).catch((e) => {
      loader.stop();
      throw e;
    });
    core.info(`Success! https://${firstDomainName} is up and running!`);

    const artifactClient = artifact.create();
    const downloadedArtifact = await artifactClient.downloadArtifact(input.deployArtifact);

    const ssh = new NodeSSH();

    await ssh.connect({
      host: firstDomainName,
      username: input.deployUser,
      privateKey: input.deployUserPrivateKey,
    });

    await ssh.putFile(downloadedArtifact.downloadPath, input.deployDirectory);

    const ps1 = `${input.deployUser}@${firstDomainName}:${input.deployDirectory}$`;
    core.info(`${ps1} ${input.deployCommand}`);

    await ssh.exec(input.deployCommand, [], {
      cwd: input.deployDirectory,
      onStdout: (chunk) => core.info(chunk.toString('utf-8')),
      onStderr: (chunk) => core.info(chunk.toString('utf-8')),
    });
  } catch (error) {
    core.setFailed(error.message);
  }
})();
