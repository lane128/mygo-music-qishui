import assert from 'node:assert/strict'
import { test } from 'node:test'
import { image } from '../helper/catalog-core.mjs'
import { avatarURL } from '../helper/avatar.mjs'
import { profileOf } from '../helper/protocol.mjs'

// Covers ask for the size the host shows them at instead of one fixed size.
test('image URLs leave their size for the host to fill in', () => {
  assert.equal(image({ uri: 'cover', urls: ['https://p3-luna.douyinpic.com/img/'], template_prefix: 'tpl' }),
    'https://p3-luna.douyinpic.com/img/cover~tpl-resize:%7Bsize%7D:%7Bsize%7D.png')
  assert.equal(image({ uri: 'cover', urls: ['https://p3-luna.douyinpic.com/img/'] }),
    'https://p3-luna.douyinpic.com/img/cover~c5_%7Bsize%7Dx%7Bsize%7D.jpg')
  assert.equal(avatarURL({ uri: 'face', urls: ['https://p3-luna.douyinpic.com/img/'], template_prefix: 'tpl' }),
    'https://p3-luna.douyinpic.com/img/face~tpl-crop-center:%7Bsize%7D:%7Bsize%7D.jpg')
})

// A complete picture URL has nowhere to put a size and stays as the service gives it.
test('leaves complete picture URLs unchanged', () => {
  assert.equal(image('https://example.invalid/cover.jpg'), 'https://example.invalid/cover.jpg')
  assert.equal(avatarURL({ need_complete_url: true, urls: ['https://example.invalid/face.jpg'] }), 'https://example.invalid/face.jpg')
})

// The account avatar uses the same placeholder as catalogue covers.
test('account avatars leave their size for the host to fill in', () => {
  const account = profileOf({ my_info: { id: '1', nickname: 'Listener', medium_avatar_url: { uri: 'face', urls: ['https://p3-luna.douyinpic.com/img/'] } } })
  assert.equal(account.imageUrl, 'https://p3-luna.douyinpic.com/img/face~c5_%7Bsize%7Dx%7Bsize%7D.jpg')
})
