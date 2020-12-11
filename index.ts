import artifact from '@actions/artifact';
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
import { find, uniq } from 'lodash';
import { NodeSSH } from 'node-ssh';
import ora from 'ora';
import shortuuid from 'short-uuid';
import waitOn from 'wait-on';
import { linodePat, rootPass } from './secrets';

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
    console.log(`Using existing ${logDomain(existingDomain)}`);
    return existingDomain;
  }

  const loader = startLoader({ text: 'Creating new Domain...' });
  const newDomain = await createDomain({ type: 'master', ...createOptions, domain });
  loader.stop();
  console.log(`Created new ${logDomain(newDomain)}`);
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
    console.log(`Using existing ${logRecord(existingRecord, domainId)}`);
    return existingRecord;
  }

  if (existingRecord && existingRecordNeedsUpdating) {
    const updatedRecord = await updateDomainRecord(domainId, existingRecord.id, attrs);
    console.log(`Updated ${logRecord(updatedRecord, domainId)}`);
    return updatedRecord;
  }

  const loader = startLoader({ text: 'Creating new Record...' });
  const newAttrs = { type: 'A' as const, ...attrs };
  const newRecord = await createDomainRecord(domainId, newAttrs);
  loader.stop();
  console.log(`Created new ${logRecord(newRecord, domainId)}`);
  return newRecord;
};

const findOrCreateLinode = async (
  label: string,
  createOptions: Omit<CreateLinodeRequest, 'stackscript_data'> & {
    root_pass: string;
    stackscript_data: {
      admin_users_json: string;
      actions_user: string;
      actions_key: string;
    };
  }
) => {
  const existingLinode = await findLinodeByLabel(label);
  if (existingLinode) {
    console.log(`Using existing ${logLinode(existingLinode)}`);
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
  console.log(`Created new ${logLinode(newLinode)}`);
  // console.log('Booting...');
  // await linodeBoot(newLinode.id);
  // console.log(`New Linode ${logLinode(newLinode)} is up and running!`);
  return newLinode;
};

(async () => {
  const input = {
    'linode-pat': linodePat,
    'admin-users-json':
      '[{"username":"kabir", "ssh_public_key":"ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDjoKT2A/FpxuIekbvbYtub4a5kvLmvZeJuxiso98yrnq+k6r4RgRJVL8bbowcl22k8UmpkBzf5yAy4BFyIEn8fhOXf57AozFq6Pcotj4Gz0YHj6zvShZjNaVauA2busQFpKr5GmrWOKcgZbAa76mWZa96xgbW60Ia3tQpOUQD53HAZCSp4Z+zVkP/iLJcfOOJmd03QesX2dUTGXoUTK0HBVeOryzqe02V1lxuGZPRrHHJAlrDOq2K4irP6W2b4x/Kfjun4P0wok4TJRqENWVtBItCOA/lKFfykxDx9JSEBbyiui6gkp3/8qYlYNAcccNqBUmNq2HVma48bAQLIpctwu3CCkJ9fsDm4WWQ2rsJBnMdZYfN4zw8rTdrDCrk8xBh+CEkPB30Nw2iKQLBAAhwK4024yr09Ti1DvBU64iObvxOwNDwZ9/CEoXLUvb5E3Ld306z3e1SNGaK8WJQ1HubNUp+su1vbG3WgA7uwa/QZeFgMHxJQOV0saWpF1IqNYHsGLbiwm0Pm2BN2h0V27L+2y8GnvuZXTFzFx4TVkJ87UeZToY4ftGsgjP7wkf0LiRLQLc5HDJqoLNebKTLpqAebVUN9UqH0fg2bwq+Io3IU8EFuy+qcxYcqNPT5vxZCSQRTQ01JcyK2tfx/LHxqISMquDA4pNjkkLzv9QOlWDWZCQ== sarink87@gmail.com"}]',
    'linode-label': `kabir-sarin.com`,
    domains: [
      { name: 'kabir-sarin.com', subdomains: [] },
      { name: 'kabirsarin.com', subdomains: [] },
      { name: 'kabir-sarin.net', subdomains: [] },
    ],
    email: 'kabir@sarink.net',
    'artifact-name': '',
    'root-pass': rootPass,
    'deploy-directory': '/srv/actions',
    'deploy-command': '',
    'actions-user': 'actions',
    'actions-private-key': '',
    'actions-key':
      'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDA1athEhnhrxBayudz2jvozqJiHrtdk7ITQdWTJgK9SfTUz/Hyq7IiJQzlhqCbxWlKQeHXjRZdUAdtD3uGZAdKHYNC5PodFhvY3gX4z/0ULcp/Yrbvd1t1tdzRxEPd+nYYyr03WX5SFnlgn0hXDdVQ9aH/sTCcYB3G6iPEFQoUhrEAnRW8C7iLLO3r5/DjJcUnnMb0g0h1W2uvofQlQCnoerR13FycZK7niKUoAKmd5EjLx7y1qFDyyTVJJO9R2kA741nIfl1/EEkVA9+284NhUbaQR+OhFXWzqWD+4pz/84EDrJxMCy7CWo4ioqX7M9+U19ponKSa2UDJK7JWvuIa2oybAOzps9Jq96J9/jxFua0VO2QOkknTO1DjZYlUIEspQUZxjlxjdNhfkT+CzGZ3l8mnNGcR8vFcpzaHkwQlxo+ZTSRD4kGy/eaVt4OX2VO+iAMaFwlZbBDCxyxqR8NG4YInR+vUiwKPxPn3+eMx9VDIAVkQ0rq+tRUe1A2sMZFzVdgGG/RXsLF9019l0ROAfO8gHphUw5Ny8vN4rsHpKpFCfrHqU0BAInbnqfQXz5CADFb/sRhEWyB/DFelEO6ZfaIukwzJjd4ZFz8hb2cVDEYZEXhEZfprlS9UdQhZzP3hpif195czCrlTB0GRbpMgTWDluPW7p2VMs3PCjXsDUw== actions',
  };

  const firstDomainName = input.domains[0].name;

  const defaults = {
    'root-pass': shortuuid.generate(),
    'admin-users-json': '[]',
    'deploy-directory': '/srv/actions',
    'actions-user': 'actions',
    'linode-label': firstDomainName,
  };

  try {
    setToken(input['linode-pat']);

    const linode = await findOrCreateLinode(input['linode-label'], {
      root_pass: input['root-pass'],
      stackscript_data: {
        admin_users_json: input['admin-users-json'],
        actions_user: input['actions-user'],
        actions_key: input['actions-key'],
      },
    });

    await Promise.all(
      input.domains.map(async (inputDomain) => {
        const domainName = inputDomain.name;
        const subdomains: string[] = inputDomain.subdomains || [];
        const domain = await findOrCreateDomain(domainName, { soa_email: input.email });
        const allARecordNames = uniq(['', ...subdomains]);
        await Promise.all(
          allARecordNames.map((name) =>
            updateOrCreateARecord(domain.id, { name, target: linode.ipv4[0] })
          )
        );
        console.log(`Successfully linked Domain ${domain.domain} with Linode ${linode.label}`);
      })
    );

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

    console.log(`Success! https://${firstDomainName} is up and running!`);

    const artifactClient = artifact.create();
    const downloadedArtifact = await artifactClient.downloadArtifact(input['artifact-name']);

    const ssh = new NodeSSH();

    await ssh.connect({
      host: firstDomainName,
      username: input['actions-user'],
      privateKey: input['actions-private-key'],
    });

    await ssh.putFile(downloadedArtifact.downloadPath, input['deploy-directory']);

    await ssh.exec(input['deploy-command'], [], {
      cwd: input['deploy-directory'],
      onStdout: (chunk) => console.log('stdoutChunk', chunk.toString('utf8')),
      onStderr: (chunk) => console.error('stderrChunk', chunk.toString('utf8')),
    });
  } catch (e) {
    console.error(e, e.message);
  }
})();
