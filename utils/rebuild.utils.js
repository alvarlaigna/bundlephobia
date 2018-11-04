const { blackList } = require("../server/config");

require('dotenv').config()
const firebase = require('firebase')
const fetch = require('node-fetch')
const fs = require('fs')
const Queue = require('promise-queue-plus')
const debug = require('debug')('rebuild:script')
const debugWarning = require('debug')('rebuild:warning')
const got = require('got')
const gitURLParse = require('git-url-parse')
const { resolvePackage } = require("./server.utils");
const { parsePackageString } = require("./common.utils");

const patchedDB = {}

function commit() {
  try {
    const stringified = JSON.stringify(patchedDB, null, 2)
    fs.writeFileSync('./db-patched.json', stringified, 'utf8');
  } catch (err) {
    console.error(err)
  }
}

const queue = new Queue(10, {
  retry: 2,               //Number of retries
  retryIsJump: false,     //retry now?
  timeout: 0,
  // queueEnd: () => {
  //   try {
  //
  //     const stringified = JSON.stringify(patchedDB, null, 2)
  //     fs.writeFileSync('./db-patched.json', stringified, 'utf8');
  //   } catch (err) {
  //     console.error(err)
  //   }
  //   // console.log('done', patchedDB)
  // }
})

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
}

firebase.initializeApp(firebaseConfig)

function encodeFirebaseKey(key) {
  return key
    .replace(/[.]/g, ',')
    .replace(/\//g, '__')
}

function decodeFirebaseKey(key) {
  return key
    .replace(/[,]/g, '.')
    .replace(/__/g, '/')
}

async function getFirebaseStore() {
  try {
    const snapshot = await firebase.database()
      .ref('modules-v2')
      .once('value')
    return snapshot.val()
  } catch (err) {
    console.log(err)
    return {}
  }
}

async function getPackageResult({ name, version }) {
  const ref = firebase.database().ref()
    .child('modules-v2')
    .child(encodeFirebaseKey(name))
    .child(encodeFirebaseKey(version))

  const snapshot = await ref.once('value')
  return snapshot.val()
}

function filterBlacklistedPackages() {
  blackList
}


async function trim(packages) {
  let canTrim = 0
  const trimsMap = {}
  Object.keys(packages).forEach(name => {
    const versions = Object.keys(packages[name]);

    if (versions.length > 15) {
      canTrim += (versions.length - 15)

      versions.slice(-15)
        .forEach((version) => {
          if(name in trimsMap) {
            trimsMap[name].push(version)
          } else {
            trimsMap[name] = [version]
          }
        })
    }
  })

  console.log('trims are', trimsMap)
  console.log('can trim', canTrim)
}

async function run() {
  let packages = []

  const packs = require('../modules-v2.json')//await getFirebaseStore()
  // // fs.writeFileSync('./db.json', JSON.stringify(packs, null, 2))
  //
  //
  // Object.keys(packs).forEach(packName => {
  //   Object.keys(packs[packName]).forEach(version => {
  //     // if (packName !== 'react') return
  //     //
  //     if (blackList.some(entry => entry.test(packName))) {
  //       return
  //     }
  //
  //     const packageString = `${decodeFirebaseKey(packName)}@${decodeFirebaseKey(version)}`
  //     queue.push(() => resolvePackage(parsePackageString(packageString)))
  //       .then(async (packInfo) => {
  //         const { description, repository } = packInfo
  //         let truncatedDescription = ''
  //         let repositoryURL = ''
  //         try {
  //           repositoryURL = gitURLParse(repository.url || repository).toString("https");
  //         } catch (e) {
  //           console.error('failed to parse repository url', repository)
  //         }
  //
  //         try {
  //           truncatedDescription = description.length > 330 ? description.substring(0, 330) + '…' : description
  //         } catch (e) {
  //           console.error('failed to parse description', description)
  //         }
  //
  //         debug('%s fetched', `${packName}@${version}`)
  //         console.log('GOT', truncatedDescription, '\n', repositoryURL)
  //
  //         if (!patchedDB[packName]) {
  //           patchedDB[packName] = {}
  //         }
  //         patchedDB[packName][version] = {
  //           description: truncatedDescription,
  //           repository: repositoryURL,
  //           ...packs[packName][version]
  //         }
  //
  //         if (packName === 'zzzz-npm-test') {
  //           commit()
  //         }
  //       })
  //       .catch((err) => {
  //         // patchedDB[packName][version] = {
  //         //   description: '',
  //         //   repository: '',
  //         //   ...packs[packName][version]
  //         // }
  //         if (packName === 'zzzz-npm-test') {
  //           commit()
  //         }
  //         console.log('fetch for ' + packageString, err)
  //       })
  //   })
  // })
  const failIndexes = []

  const startIndex = 2336
  const endIndex = 5000

  Object.keys(packs).forEach(packName => {
    Object.keys(packs[packName]).forEach(version => {
      packages.push({ packName, version })
    })
  })

  packages = packages.filter(pack => packs[pack.packName][pack.version].gzip < (300 * 1024))
  console.log('total packages', packages.length)

  packages
    .slice(startIndex, endIndex)
    .forEach((pack, index) => {
        const packStr = `${decodeFirebaseKey(pack.packName)}@${decodeFirebaseKey(pack.version)}`
        queue.push(() => got(`http://127.0.0.1:5000/api/size?package=${packStr}&force=true`, { json: true })
          .then(async (r) => {
            const res = r.body
            const gzipDiff = Math.abs(res.gzip - packs[pack.packName][pack.version].gzip)
            const minDiff = Math.abs(res.size - packs[pack.packName][pack.version].size)
            debug('%d fetched %s, diff: %d KB', (startIndex + index), packStr, Math.round(gzipDiff / 1024))

            if (((gzipDiff / packs[pack.packName][pack.version].gzip) > 0.05) && gzipDiff > 4000) {
              debugWarning('GZIP sizes for %s vary more than %d. Old: %d KB, After rebuild: %d KB', packStr, gzipDiff, Math.round(packs[pack.packName][pack.version].gzip / 1024), Math.round(res.gzip / 1024))
            }
            if (((minDiff / packs[pack.packName][pack.version].size) > 0.05) && minDiff > 7000) {
              debugWarning('MIN sizes for %s vary more than %d. Old: %d KB, After rebuild: %d KB', packStr, minDiff, Math.round(packs[pack.packName][pack.version].size / 1024), Math.round(res.size / 1024))
            }
          })
          .catch((err) => {
            failIndexes.push(startIndex + index)
            console.log('fetch for ' + packStr + ' failed', err)
            throw err
          }))
      }
    )
  queue.start()
  // fs.writeFileSync(`./failures-${startIndex}-${endIndex}.json`, JSON.stringify({failures: failIndexes}), 'utf8')

}

run()
// trim(require('../modules-v2.json'))
